/**
 * Consolidação das EXPLICAÇÕES (ex.: Iron Ores) — VALORES armazenados por
 * versão e mês (como os indicadores); a diferença entre cenários e o impacto
 * são calculados aqui, na leitura, depois da seleção do par. Para um par
 * FY/trimestre, o painel expande o par em pares mensais (mês i da origem ↔
 * mês i do destino), calcula cada mês e soma.
 *
 * Regras de consolidação:
 *  - impacto ($m) e volume (kt): somados entre os meses;
 *  - valores de preço (origem/destino/variação): mostrados apenas quando o
 *    par cobre um único mês — somar preços não faz sentido;
 *  - itens vinculados (Fines, Pellets...): definidos por indicador.
 */
import type {
  MarketIndicator,
  MarketIndicatorLine,
  MarketIndicatorValue,
  MarketIndicatorItem,
} from "@workspace/db";

const MONTH_ID = /^fy(\d{2})_m(\d{2})_(.+)$/;
const DERIVED_ID = /^fy(\d{2})_(fy|q[1-4])_(.+)$/;
const QUARTER_MONTHS: Record<string, number[]> = {
  q1: [1, 2, 3],
  q2: [4, 5, 6],
  q3: [7, 8, 9],
  q4: [10, 11, 12],
};
const MONTH_NAMES = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/** Meses (ids mensais) cobertos por um id de cenário; o próprio id se mensal. */
export function monthIdsOf(id: string): string[] {
  if (MONTH_ID.test(id)) return [id];
  const d = id.match(DERIVED_ID);
  if (!d) return [id];
  const months = d[2] === "fy" ? Array.from({ length: 12 }, (_, i) => i + 1) : QUARTER_MONTHS[d[2]];
  return months.map((m) => `fy${d[1]}_m${String(m).padStart(2, "0")}_${d[3]}`);
}

/** Rótulo do mês de um id mensal (fy26_m02_x → "FEB26"). */
export function monthLabelOf(monthId: string): string {
  const m = monthId.match(MONTH_ID);
  if (!m) return monthId;
  return `${MONTH_NAMES[Number(m[2]) - 1]}${m[1]}`;
}

export type MonthPair = { sourceId: string; targetId: string; label: string };

/**
 * Pares mensais de um par de cenários (mês i da origem ↔ mês i do destino).
 * Retorna null quando as granularidades não batem (ex.: FY × trimestre) —
 * nunca trunca o intervalo para não apresentar uma soma parcial como válida.
 */
export function monthPairsOf(sourceId: string, targetId: string): MonthPair[] | null {
  const src = monthIdsOf(sourceId);
  const tgt = monthIdsOf(targetId);
  if (src.length !== tgt.length) return null;
  return src.map((s, i) => ({
    sourceId: s,
    targetId: tgt[i],
    label: monthLabelOf(tgt[i]),
  }));
}

type LineOut = {
  id: number;
  label: string;
  sourceValue?: number;
  targetValue?: number;
  varValue?: number;
  volumeKt?: number;
  impactMusd: number;
};

export type ConsolidatedExplanation = {
  id: number;
  sourceId: string;
  targetId: string;
  title: string;
  unitLabel: string;
  totalMusd: number;
  items: string[];
  lines: LineOut[];
  months: { periodLabel: string; totalMusd: number; lines: LineOut[] }[];
};

/**
 * Calcula a linha de um mês a partir dos VALORES por versão: variação =
 * destino − origem; impacto = direction × variação × kt (linhas de preço,
 * SEMPRE o kt do mês destino — sem fallback) ou direction × variação
 * (linhas de montante em MUSD). Sem os dois valores não há impacto.
 */
function computeMonthLine(
  line: MarketIndicatorLine,
  src: MarketIndicatorValue | undefined,
  tgt: MarketIndicatorValue | undefined,
): LineOut | null {
  if (!src && !tgt) return null;
  const sv = src?.value ?? null;
  const tv = tgt?.value ?? null;
  const kt = tgt?.volumeKt ?? null;
  const varValue = sv != null && tv != null ? tv - sv : null;
  let impact = 0;
  if (varValue != null) {
    if (line.kind === "amount") impact = line.direction * varValue;
    else if (kt != null) impact = line.direction * varValue * kt;
  }
  // Linhas de montante (MUSD): só o impacto interessa — os "níveis" internos
  // não são preços e não devem aparecer nas colunas de preço do pop-up.
  const isPrice = line.kind !== "amount";
  return {
    id: line.id,
    label: line.label,
    ...(isPrice && sv != null ? { sourceValue: sv } : {}),
    ...(isPrice && tv != null ? { targetValue: tv } : {}),
    ...(isPrice && varValue != null ? { varValue } : {}),
    ...(isPrice && kt != null ? { volumeKt: kt } : {}),
    impactMusd: impact,
  };
}

/**
 * Consolida os indicadores de explicação para os pares mensais pedidos.
 * `values` são as linhas cruas de valores por cenário mensal dos dois lados.
 */
export function consolidateMarketIndicators(
  requested: { sourceId: string; targetId: string },
  pairs: MonthPair[],
  indicators: MarketIndicator[],
  lines: MarketIndicatorLine[],
  values: MarketIndicatorValue[],
  items: MarketIndicatorItem[],
): ConsolidatedExplanation[] {
  const linesByIndicator = new Map<number, MarketIndicatorLine[]>();
  for (const l of lines) {
    const arr = linesByIndicator.get(l.indicatorId) ?? [];
    arr.push(l);
    linesByIndicator.set(l.indicatorId, arr);
  }
  for (const arr of linesByIndicator.values()) {
    arr.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  }
  const valueByLineScenario = new Map<string, MarketIndicatorValue>();
  for (const v of values) valueByLineScenario.set(`${v.lineId}|${v.scenarioId}`, v);
  const itemsByIndicator = new Map<number, string[]>();
  for (const i of items) {
    const arr = itemsByIndicator.get(i.indicatorId) ?? [];
    arr.push(i.item);
    itemsByIndicator.set(i.indicatorId, arr);
  }

  const singleMonth = pairs.length === 1;
  const out: ConsolidatedExplanation[] = [];
  const sorted = [...indicators].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  for (const ind of sorted) {
    const indLines = linesByIndicator.get(ind.id) ?? [];
    const months: ConsolidatedExplanation["months"] = [];
    for (const p of pairs) {
      const monthLines: LineOut[] = [];
      for (const l of indLines) {
        const computed = computeMonthLine(
          l,
          valueByLineScenario.get(`${l.id}|${p.sourceId}`),
          valueByLineScenario.get(`${l.id}|${p.targetId}`),
        );
        if (computed) monthLines.push(computed);
      }
      if (monthLines.length === 0) continue;
      months.push({
        periodLabel: p.label,
        totalMusd: monthLines.reduce((s, l) => s + l.impactMusd, 0),
        lines: monthLines,
      });
    }
    if (months.length === 0) continue;

    // Linhas consolidadas: impacto e kt somados entre os meses; preços só
    // quando o par cobre um único mês (somar preços não faz sentido).
    const byLine = new Map<number, LineOut>();
    for (const m of months) {
      for (const l of m.lines) {
        const cur = byLine.get(l.id);
        if (!cur) {
          byLine.set(
            l.id,
            singleMonth
              ? { ...l }
              : {
                  id: l.id,
                  label: l.label,
                  ...(l.volumeKt != null ? { volumeKt: l.volumeKt } : {}),
                  impactMusd: l.impactMusd,
                },
          );
        } else {
          cur.impactMusd += l.impactMusd;
          if (l.volumeKt != null) cur.volumeKt = (cur.volumeKt ?? 0) + l.volumeKt;
        }
      }
    }
    out.push({
      id: ind.id,
      sourceId: requested.sourceId,
      targetId: requested.targetId,
      title: ind.title,
      unitLabel: ind.unitLabel,
      totalMusd: months.reduce((s, m) => s + m.totalMusd, 0),
      items: itemsByIndicator.get(ind.id) ?? [],
      lines: [...byLine.values()],
      months,
    });
  }
  return out;
}
