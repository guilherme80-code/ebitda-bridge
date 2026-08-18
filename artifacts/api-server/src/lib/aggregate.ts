/**
 * Consolidação mensal → FY / trimestre ("consolidar primeiro").
 *
 * A fonte de dados é mensal: cada versão (Actual, Budget, MRF1..) tem até 12
 * cenários mensais. FY e trimestres não vêm da fonte — são cenários DERIVADOS
 * aqui, somando os meses e recalculando taxas/razões como médias ponderadas:
 *
 *  - somas: quantidades, receitas, custos variáveis, custo fixo, montantes de
 *    insumos diretos e ajustes, EBITDA e aço bruto;
 *  - câmbio geral: ponderado pela receita doméstica (base do efeito câmbio);
 *  - câmbio do custo fixo: ponderado pelos custos fixos em BRL;
 *  - participação do custo doméstico: ponderada pelo custo (EBITDA − receita);
 *  - preço unitário de insumo: ponderado pelo consumo mensal
 *    (rendimento × aço bruto); rendimento: ponderado pelo aço bruto.
 *
 * Um cenário derivado só "tem dados" quando TODOS os meses do período têm
 * dados — evita consolidar um FY/trimestre parcial e fechar a ponte com plug.
 */
import type { Scenario } from "@workspace/db";
import type { RawScenarioData } from "./bridge-calc";

const QUARTER_MONTHS: Record<number, number[]> = {
  1: [1, 2, 3],
  2: [4, 5, 6],
  3: [7, 8, 9],
  4: [10, 11, 12],
};

const MONTH_ID = /^fy(\d{2})_m(\d{2})_(.+)$/;
const SCENARIO_ID = /^fy(\d{2})_(fy|q([1-4])|m(\d{2}))_(.+)$/;
const SCENARIO_YEAR_SORT_BASE = 100_000_000;

export interface DerivedScenario extends Scenario {
  /** ids dos cenários mensais que compõem o derivado, em ordem (todos os esperados) */
  monthIds: string[];
}

function versionOrderIndex(version: string): number {
  const v = version.trim().toUpperCase();
  if (v === "ACTUAL") return 0;
  if (v === "BUDGET") return 1;
  const mrf = v.match(/^MRF([1-9]|1[0-2])$/);
  return mrf ? Number(mrf[1]) + 1 : Number.MAX_SAFE_INTEGER;
}

/**
 * Ordena cenários por ano, granularidade e versão. O banco pode conter
 * sort_order produzido por uma versão antiga do importador, então o catálogo
 * não depende somente dessa coluna.
 */
export function compareScenarios(a: Scenario, b: Scenario): number {
  const pa = a.id.match(SCENARIO_ID);
  const pb = b.id.match(SCENARIO_ID);
  if (!pa || !pb) {
    return a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);
  }
  const year = Number(pa[1]) - Number(pb[1]);
  if (year !== 0) return year;
  const kindOrder = (kind: string) => (kind === "fy" ? 0 : kind.startsWith("q") ? 1 : 2);
  const kind = kindOrder(pa[2]) - kindOrder(pb[2]);
  if (kind !== 0) return kind;
  const version = versionOrderIndex(pa[5]) - versionOrderIndex(pb[5]);
  if (version !== 0) return version;
  const period = Number(pa[3] ?? pa[4] ?? 0) - Number(pb[3] ?? pb[4] ?? 0);
  return period || a.id.localeCompare(b.id);
}

const MONTH_NAMES = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/** Rótulo de período mensal (ex.: fy26_m02_budget → "FEB26"). */
export function monthPeriodLabel(monthId: string): string {
  const p = parseMonthId(monthId);
  if (!p) return monthId;
  return `${MONTH_NAMES[p.month - 1]}${p.yy}`;
}

/** Extrai {yy, month, versionSlug} de um id mensal (fy26_m01_budget). */
function parseMonthId(id: string) {
  const m = id.match(MONTH_ID);
  if (!m) return null;
  return { yy: m[1], month: Number(m[2]), vSlug: m[3] };
}

/**
 * Deriva os cenários de FY e trimestre a partir dos cenários mensais do
 * catálogo, seguindo as convenções de id/ordenação históricas do painel
 * (fy26_fy_budget, fy26_q1_mrf3...). A ordenação da versão é recuperada da
 * própria ordenação mensal (sort = 10000 + (vi+1)*100 + mês).
 */
export function deriveScenarios(monthly: Scenario[]): DerivedScenario[] {
  type Bucket = { yy: string; vSlug: string; version: string; byMonth: Map<number, Scenario> };
  const buckets = new Map<string, Bucket>();
  for (const s of monthly) {
    if (s.periodKind !== "month") continue;
    const p = parseMonthId(s.id);
    if (!p) continue;
    const key = `${p.yy}:${p.vSlug}`;
    const b =
      buckets.get(key) ?? { yy: p.yy, vSlug: p.vSlug, version: s.version, byMonth: new Map() };
    b.byMonth.set(p.month, s);
    buckets.set(key, b);
  }

  const out: DerivedScenario[] = [];
  for (const b of buckets.values()) {
    const anyMonth = [...b.byMonth.values()][0];
    // vi reconstruído da ordenação mensal (10000 + (vi+1)*100 + mês-1)
    const vi = versionOrderIndex(b.version);
    const yearBase = SCENARIO_YEAR_SORT_BASE + Number(b.yy) * 1_000_000;
    const vLabel = anyMonth.label.replace(/^\S+\s*/, ""); // "JAN26 Budget" → "Budget"

    // Emite o derivado mesmo com meses faltando — quem decide se ele "tem
    // dados" é o catálogo (todos os meses presentes E com dados). Assim o
    // seletor pode mostrar o período desabilitado com os meses faltantes.
    const monthId = (mm: number) =>
      `fy${b.yy}_m${String(mm).padStart(2, "0")}_${b.vSlug}`;
    out.push({
      id: `fy${b.yy}_fy_${b.vSlug}`,
      version: b.version,
      period: `FY${b.yy}`,
      periodKind: "year",
      label: `FY${b.yy} ${vLabel}`,
      sortOrder: yearBase + vi * 1000,
      monthIds: Array.from({ length: 12 }, (_, i) => monthId(i + 1)),
    });
    for (const [q, months] of Object.entries(QUARTER_MONTHS)) {
      out.push({
        id: `fy${b.yy}_q${q}_${b.vSlug}`,
        version: b.version,
        period: `Q${q}${b.yy}`,
        periodKind: "quarter",
        label: `Q${q}${b.yy} ${vLabel}`,
        sortOrder: yearBase + 100_000 + vi * 10 + (Number(q) - 1),
        monthIds: months.map(monthId),
      });
    }
  }
  return out.sort(compareScenarios);
}

/** Média ponderada; cai na média simples quando a soma dos pesos é ~0. */
function weighted(pairs: { value: number; weight: number }[]): number {
  const valid = pairs.filter((p) => Number.isFinite(p.value));
  if (valid.length === 0) return 0;
  const wSum = valid.reduce((s, p) => s + Math.abs(p.weight), 0);
  if (wSum < 1e-12) return valid.reduce((s, p) => s + p.value, 0) / valid.length;
  return valid.reduce((s, p) => s + p.value * Math.abs(p.weight), 0) / wSum;
}

/**
 * Agrega os fatos mensais de um período em um único RawScenarioData,
 * pronto para o computeBridge — somas para grandezas aditivas e médias
 * ponderadas para taxas/razões (ver cabeçalho do módulo).
 */
export function aggregateMonths(
  scenarioId: string,
  months: RawScenarioData[],
): RawScenarioData {
  if (months.length === 0) {
    throw new Error(`Agregação sem meses para o cenário ${scenarioId}`);
  }

  // ---------- parâmetros ----------
  const ebitdaKusd = months.reduce((s, m) => s + m.params.ebitdaKusd, 0);
  const crudeSteelKt = months.reduce((s, m) => s + m.params.crudeSteelKt, 0);
  const domRev = (m: RawScenarioData) =>
    m.sales.filter((r) => r.domestic).reduce((s, r) => s + r.amountKusd, 0);
  const fxRate = weighted(months.map((m) => ({ value: m.params.fxRate, weight: domRev(m) })));
  const brlFixed = (m: RawScenarioData) =>
    m.fixed.filter((f) => !f.usdDenominated).reduce((s, f) => s + Math.abs(f.amountKusd), 0);
  const fcFxRate = weighted(
    months.map((m) => ({ value: m.params.fcFxRate || m.params.fxRate, weight: brlFixed(m) })),
  );
  const cost = (m: RawScenarioData) =>
    Math.abs(m.params.ebitdaKusd - m.sales.reduce((s, r) => s + r.amountKusd, 0));
  const dmCostShare = weighted(
    months.map((m) => ({ value: m.params.dmCostShare, weight: cost(m) })),
  );

  // A classificação de um item não pode mudar entre os meses consolidados —
  // moeda/mercado (vendas), flag USD (custo fixo) e formato (insumos) alteram
  // como o câmbio e os efeitos são atribuídos ao período inteiro. A importação
  // já barra isso; aqui é a última linha de defesa.
  const conflict = (tipo: string, chave: string): never => {
    throw new Error(
      `Consolidação de ${scenarioId}: ${tipo} "${chave}" com classificação ` +
        `inconsistente entre os meses (moeda/atributo/formato deve ser igual em todos os meses)`,
    );
  };

  // ---------- vendas: soma por produto ----------
  type S = RawScenarioData["sales"][number];
  const salesByKey = new Map<string, S>();
  for (const m of months) {
    for (const r of m.sales) {
      const acc = salesByKey.get(r.productKey);
      if (!acc) {
        salesByKey.set(r.productKey, { ...r, scenarioId });
      } else {
        if (acc.currency !== r.currency || acc.domestic !== r.domestic) {
          conflict("produto", r.label);
        }
        acc.qtyKt += r.qtyKt;
        acc.amountKusd += r.amountKusd;
        acc.varCostKusd += r.varCostKusd;
      }
    }
  }

  // ---------- custo fixo: soma por categoria ----------
  type F = RawScenarioData["fixed"][number];
  const fixedByCat = new Map<string, F>();
  for (const m of months) {
    for (const r of m.fixed) {
      const acc = fixedByCat.get(r.category);
      if (!acc) fixedByCat.set(r.category, { ...r, scenarioId });
      else {
        if (acc.usdDenominated !== r.usdDenominated) {
          conflict("categoria de custo fixo", r.category);
        }
        acc.amountKusd += r.amountKusd;
      }
    }
  }

  // ---------- insumos: montantes somam; preço/rendimento ponderados ----------
  type I = RawScenarioData["inputs"][number];
  const inputRows = new Map<string, { rows: { row: I; crude: number }[] }>();
  for (const m of months) {
    for (const r of m.inputs) {
      const acc = inputRows.get(r.item) ?? { rows: [] };
      acc.rows.push({ row: r, crude: m.params.crudeSteelKt });
      inputRows.set(r.item, acc);
    }
  }
  const inputs: I[] = [];
  for (const { rows } of inputRows.values()) {
    const first = rows[0].row;
    const priced = rows.some(({ row }) => row.unitPriceUsd != null);
    if (priced && rows.some(({ row }) => row.unitPriceUsd == null)) {
      conflict("insumo", first.item); // mistura preco_usd_t e montante_kusd entre meses
    }
    if (priced) {
      // consumo mensal = rendimento × aço bruto (mesma base do efeito no bridge)
      const yieldFactor = weighted(
        rows.map(({ row, crude }) => ({ value: row.yieldFactor ?? 0, weight: crude })),
      );
      const unitPriceUsd = weighted(
        rows.map(({ row, crude }) => ({
          value: row.unitPriceUsd ?? 0,
          weight: (row.yieldFactor ?? 0) * crude,
        })),
      );
      inputs.push({ ...first, scenarioId, unitPriceUsd, yieldFactor, amountKusd: null });
    } else {
      const amountKusd = rows.reduce((s, { row }) => s + (row.amountKusd ?? 0), 0);
      inputs.push({ ...first, scenarioId, unitPriceUsd: null, yieldFactor: null, amountKusd });
    }
  }

  // ---------- ajustes (consumo/outros/estoque): soma por driver+label ----------
  type M = RawScenarioData["misc"][number];
  const miscByKey = new Map<string, M>();
  for (const m of months) {
    for (const r of m.misc) {
      const key = `${r.driver}:${r.label}`;
      const acc = miscByKey.get(key);
      if (!acc) miscByKey.set(key, { ...r, scenarioId });
      else acc.amountKusd += r.amountKusd;
    }
  }

  const bySort = <T extends { sortOrder: number }>(a: T, b: T) => a.sortOrder - b.sortOrder;
  return {
    params: {
      scenarioId,
      fxRate,
      fcFxRate,
      crudeSteelKt,
      ebitdaKusd,
      dmCostShare,
    },
    sales: [...salesByKey.values()].sort(bySort),
    fixed: [...fixedByCat.values()].sort(bySort),
    inputs: inputs.sort(bySort),
    misc: [...miscByKey.values()].sort(bySort),
  };
}
