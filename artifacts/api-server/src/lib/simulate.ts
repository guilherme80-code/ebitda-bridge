/**
 * Simulação de cenários a partir de ajustes estruturados (interpretados de um
 * prompt em linguagem natural). Os ajustes são aplicados sobre os dados brutos
 * do cenário indicado e o bridge é recalculado com o motor oficial.
 *
 * Consistência do EBITDA: ao alterar um dado bruto (ex.: +10% de volume), o
 * EBITDA do cenário ajustado é resolvido de modo que o plug de fechamento
 * (Estoque/Outros) permaneça igual ao do bridge original — ou seja, todo o
 * efeito simulado flui para o EBITDA final, sem ser absorvido pelo plug.
 * Como o driver de câmbio depende do próprio EBITDA (parcela de custo
 * doméstico), a solução é iterada algumas vezes até convergir.
 */
import {
  computeBridge,
  type RawScenarioData,
  type BridgeResult,
  type BridgeTable,
} from "./bridge-calc";

export interface Adjustment {
  scope:
    | "sales_qty"
    | "sales_price"
    | "fixed_cost"
    | "input_price"
    | "usage"
    | "others"
    | "fx";
  scenario: "source" | "target";
  /** Rótulo do item conforme o catálogo (fuzzy-matched se necessário). */
  key: string;
  /** Variação percentual (ex.: 10 = +10%). */
  pct?: number | null;
  /** Variação absoluta: kt p/ volume, USD/t p/ preço de venda e insumos
   * precificados, MUSD p/ montantes, unidades de câmbio p/ fx. */
  abs?: number | null;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function findByLabel<T>(items: T[], getLabel: (t: T) => string, key: string): T[] {
  const nk = norm(key);
  const exact = items.filter((i) => norm(getLabel(i)) === nk);
  if (exact.length) return exact;
  return items.filter(
    (i) => norm(getLabel(i)).includes(nk) || nk.includes(norm(getLabel(i))),
  );
}

function clone(raw: RawScenarioData): RawScenarioData {
  return {
    params: { ...raw.params },
    sales: raw.sales.map((r) => ({ ...r })),
    fixed: raw.fixed.map((r) => ({ ...r })),
    inputs: raw.inputs.map((r) => ({ ...r })),
    misc: raw.misc.map((r) => ({ ...r })),
  };
}

const fmtPct = (p: number) => `${p > 0 ? "+" : ""}${p}%`;

/** Aplica um ajuste; devolve a descrição do que foi feito ou null se o item não foi encontrado. */
function applyOne(raw: RawScenarioData, adj: Adjustment, scenarioLabel: string): string | null {
  const pct = adj.pct ?? null;
  const abs = adj.abs ?? null;
  if (pct == null && abs == null) return null;
  const factor = pct != null ? 1 + pct / 100 : 1;

  switch (adj.scope) {
    case "sales_qty": {
      const rows = findByLabel(raw.sales, (r) => r.label, adj.key);
      if (!rows.length) return null;
      for (const r of rows) {
        const f = pct != null ? factor : r.qtyKt !== 0 ? (r.qtyKt + abs! * 1000) / r.qtyKt : 1;
        r.qtyKt *= f;
        r.amountKusd *= f;
        r.varCostKusd *= f;
      }
      const what = rows.map((r) => r.label).join(", ");
      return pct != null
        ? `Volume de ${what} ${fmtPct(pct)} em ${scenarioLabel}`
        : `Volume de ${what} ${abs! > 0 ? "+" : ""}${abs} kt em ${scenarioLabel}`;
    }
    case "sales_price": {
      const rows = findByLabel(raw.sales, (r) => r.label, adj.key);
      if (!rows.length) return null;
      for (const r of rows) {
        if (pct != null) r.amountKusd *= factor;
        else r.amountKusd += (abs! * r.qtyKt) / 1000; // USD/t × t → kUSD
      }
      const what = rows.map((r) => r.label).join(", ");
      return pct != null
        ? `Preço de ${what} ${fmtPct(pct)} em ${scenarioLabel}`
        : `Preço de ${what} ${abs! > 0 ? "+" : ""}${abs} USD/t em ${scenarioLabel}`;
    }
    case "fixed_cost": {
      const rows = findByLabel(raw.fixed, (r) => r.category, adj.key);
      if (!rows.length) return null;
      for (const r of rows) {
        if (pct != null) r.amountKusd *= factor;
        else r.amountKusd += abs! * 1000;
      }
      const what = rows.map((r) => r.category).join(", ");
      return pct != null
        ? `Custo fixo ${what} ${fmtPct(pct)} em ${scenarioLabel}`
        : `Custo fixo ${what} ${abs! > 0 ? "+" : ""}${abs} MUSD em ${scenarioLabel}`;
    }
    case "input_price": {
      const rows = findByLabel(raw.inputs, (r) => r.item, adj.key);
      if (!rows.length) return null;
      for (const r of rows) {
        if (r.unitPriceUsd != null) {
          if (pct != null) r.unitPriceUsd *= factor;
          else r.unitPriceUsd += abs!;
        } else if (r.amountKusd != null) {
          if (pct != null) r.amountKusd *= factor;
          else r.amountKusd += abs! * 1000;
        }
      }
      const what = rows.map((r) => r.item).join(", ");
      return pct != null
        ? `Preço de insumo ${what} ${fmtPct(pct)} em ${scenarioLabel}`
        : `Preço de insumo ${what} ${abs! > 0 ? "+" : ""}${abs} em ${scenarioLabel}`;
    }
    case "usage":
    case "others": {
      const pool = raw.misc.filter((m) =>
        adj.scope === "usage" ? m.driver === "usage" : m.driver !== "usage",
      );
      const rows = findByLabel(pool, (r) => r.label, adj.key);
      if (!rows.length) return null;
      for (const r of rows) {
        if (pct != null) r.amountKusd *= factor;
        else r.amountKusd += abs! * 1000;
      }
      const what = rows.map((r) => r.label).join(", ");
      return pct != null
        ? `${what} ${fmtPct(pct)} em ${scenarioLabel}`
        : `${what} ${abs! > 0 ? "+" : ""}${abs} MUSD em ${scenarioLabel}`;
    }
    case "fx": {
      if (pct != null) {
        raw.params.fxRate *= factor;
        if (raw.params.fcFxRate) raw.params.fcFxRate *= factor;
        return `Câmbio (BRL/USD) ${fmtPct(pct)} em ${scenarioLabel}`;
      }
      raw.params.fxRate += abs!;
      if (raw.params.fcFxRate) raw.params.fcFxRate += abs!;
      return `Câmbio (BRL/USD) ${abs! > 0 ? "+" : ""}${abs} em ${scenarioLabel}`;
    }
  }
}

export interface SimulationOutcome {
  bridge: BridgeResult;
  applied: string[];
  notFound: string[];
}

export function simulateBridge(
  source: RawScenarioData,
  target: RawScenarioData,
  adjustments: Adjustment[],
  labels: { source: string; target: string },
): SimulationOutcome {
  const base = computeBridge(source, target);
  const basePlug = base.drivers["sv_others"] ?? 0;

  const simSource = clone(source);
  const simTarget = clone(target);
  const applied: string[] = [];
  const notFound: string[] = [];
  let touchedSource = false;
  let touchedTarget = false;

  for (const adj of adjustments) {
    const isSource = adj.scenario === "source";
    const raw = isSource ? simSource : simTarget;
    const desc = applyOne(raw, adj, isSource ? labels.source : labels.target);
    if (desc) {
      applied.push(desc);
      if (isSource) touchedSource = true;
      else touchedTarget = true;
    } else {
      notFound.push(adj.key);
    }
  }

  if (!applied.length) {
    return { bridge: base, applied, notFound };
  }

  // Resolve o EBITDA do(s) cenário(s) ajustado(s) mantendo o plug de
  // fechamento (Estoque/Outros) igual ao do bridge original.
  let bridge = base;
  for (let i = 0; i < 4; i++) {
    bridge = computeBridge(simSource, simTarget);
    const sumOthers = Object.entries(bridge.drivers)
      .filter(([k]) => k !== "sv_others")
      .reduce((s, [, v]) => s + v, 0);
    if (touchedTarget || !touchedSource) {
      // EBITDA destino tal que plug == basePlug
      simTarget.params.ebitdaKusd = (bridge.start + basePlug + sumOthers) * 1000;
    }
    if (touchedSource) {
      simSource.params.ebitdaKusd = (bridge.end - basePlug - sumOthers) * 1000;
    }
  }
  bridge = computeBridge(simSource, simTarget);

  return { bridge, applied, notFound };
}

export interface SimulatedTableRow {
  label: string;
  kind: "row" | "subtotal" | "total";
  values: (number | null)[];
  baseValues: (number | null)[];
  changed: boolean[];
}

export interface SimulatedTable {
  key: string;
  title: string;
  columns: BridgeTable["columns"];
  rows: SimulatedTableRow[];
}

/** Abaixo do arredondamento de exibição (0,1) — diferenças menores não são
 * marcadas como alteradas. */
export const CHANGE_EPS = 0.05;

/**
 * Pareia as tabelas do bridge simulado com as do bridge original, produzindo
 * para cada linha os valores simulados, os valores originais (`baseValues`) e
 * as flags `changed` — sempre com o mesmo número de colunas/linhas do bridge
 * simulado (que compartilha a estrutura do bridge base, pois os ajustes só
 * alteram valores de linhas existentes).
 */
export function buildSimulatedTables(
  sim: BridgeResult,
  base: BridgeResult,
): SimulatedTable[] {
  return sim.tables.map((table) => {
    const baseTable = base.tables.find((t) => t.key === table.key);
    return {
      key: table.key,
      title: table.title,
      columns: table.columns,
      rows: table.rows.map((row, i) => {
        const baseRow =
          baseTable?.rows.find(
            (r, j) => r.label === row.label && r.kind === row.kind && j === i,
          ) ??
          baseTable?.rows.find(
            (r) => r.label === row.label && r.kind === row.kind,
          );
        const baseValues = row.values.map(
          (_, j) => baseRow?.values[j] ?? null,
        );
        const changed = row.values.map((v, j) => {
          const b = baseValues[j];
          if (v == null && b == null) return false;
          if (v == null || b == null) return true;
          return Math.abs(v - b) > CHANGE_EPS;
        });
        return {
          label: row.label,
          kind: row.kind,
          values: row.values,
          baseValues,
          changed,
        };
      }),
    };
  });
}

/** Catálogo de itens ajustáveis (união origem + destino), para orientar a
 * interpretação do prompt. */
export function buildCatalog(source: RawScenarioData, target: RawScenarioData) {
  const uniq = (xs: string[]) => Array.from(new Set(xs));
  return {
    sales: uniq([...source.sales, ...target.sales].map((r) => r.label)),
    fixed_cost: uniq([...source.fixed, ...target.fixed].map((r) => r.category)),
    input_price: uniq([...source.inputs, ...target.inputs].map((r) => r.item)),
    usage: uniq(
      [...source.misc, ...target.misc]
        .filter((m) => m.driver === "usage")
        .map((m) => m.label),
    ),
    others: uniq(
      [...source.misc, ...target.misc]
        .filter((m) => m.driver !== "usage")
        .map((m) => m.label),
    ),
  };
}
