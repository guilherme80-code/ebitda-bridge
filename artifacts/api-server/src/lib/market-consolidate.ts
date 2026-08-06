/**
 * Consolidação das EXPLICAÇÕES (ex.: Iron Ores) — VALORES armazenados por
 * versão e mês (como os indicadores); a diferença entre cenários e o impacto
 * são calculados aqui, na leitura, depois da seleção do par. Para um par
 * FY/trimestre, o painel expande o par em pares mensais (mês i da origem ↔
 * mês i do destino), calcula cada mês e soma.
 *
 * Regras de consolidação (tabela única, sem abertura mensal):
 *  - impacto ($m) e volume (kt): somados entre os meses;
 *  - valores de preço (origem/destino): média ponderada pelo kt do próprio
 *    mês/lado (somar preços não faz sentido); Var = destino − origem das
 *    médias. O impacto continua sendo a soma dos impactos mensais — a
 *    aproximação Var × kt total pode divergir por arredondamento de mix;
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
};

/** Média ponderada; pesos ausentes/zerados em TODOS os pontos → média simples. */
function weightedAvg(points: { v: number; w: number | null }[]): number | null {
  if (points.length === 0) return null;
  const totalW = points.reduce((s, p) => s + (p.w ?? 0), 0);
  if (totalW > 0 && points.every((p) => p.w != null)) {
    return points.reduce((s, p) => s + p.v * (p.w as number), 0) / totalW;
  }
  return points.reduce((s, p) => s + p.v, 0) / points.length;
}

/**
 * Impacto de um mês: variação = destino − origem; impacto = direction ×
 * variação × kt (linhas de preço, SEMPRE o kt do mês destino — sem fallback)
 * ou direction × variação (linhas de montante em MUSD). Sem os dois valores
 * não há impacto.
 */
function monthImpact(
  line: MarketIndicatorLine,
  src: MarketIndicatorValue | undefined,
  tgt: MarketIndicatorValue | undefined,
): number {
  const sv = src?.value ?? null;
  const tv = tgt?.value ?? null;
  if (sv == null || tv == null) return 0;
  const varValue = tv - sv;
  if (line.kind === "amount") return line.direction * varValue;
  const kt = tgt?.volumeKt ?? null;
  return kt != null ? line.direction * varValue * kt : 0;
}

/**
 * Consolida os indicadores de explicação para os pares mensais pedidos em uma
 * única tabela por indicador (sem abertura mensal).
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

  const out: ConsolidatedExplanation[] = [];
  const sorted = [...indicators].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  for (const ind of sorted) {
    const outLines: LineOut[] = [];
    for (const l of linesByIndicator.get(ind.id) ?? []) {
      type Pt = { v: number; w: number | null };
      const srcPoints: Pt[] = [];
      const tgtPoints: Pt[] = [];
      // Meses "pareados" (valor dos DOIS lados): só eles podem gerar variação
      // — comparar médias de populações de meses diferentes não faz sentido.
      const matchedSrc: Pt[] = [];
      const matchedTgt: Pt[] = [];
      let volumeKt: number | null = null;
      let impact = 0;
      let hasData = false;
      for (const p of pairs) {
        const src = valueByLineScenario.get(`${l.id}|${p.sourceId}`);
        const tgt = valueByLineScenario.get(`${l.id}|${p.targetId}`);
        if (!src && !tgt) continue;
        hasData = true;
        if (src?.value != null) srcPoints.push({ v: src.value, w: src.volumeKt });
        if (tgt?.value != null) tgtPoints.push({ v: tgt.value, w: tgt.volumeKt });
        if (src?.value != null && tgt?.value != null) {
          matchedSrc.push({ v: src.value, w: src.volumeKt });
          matchedTgt.push({ v: tgt.value, w: tgt.volumeKt });
        }
        if (tgt?.volumeKt != null) volumeKt = (volumeKt ?? 0) + tgt.volumeKt;
        impact += monthImpact(l, src, tgt);
      }
      if (!hasData) continue;
      const isPrice = l.kind !== "amount";
      // Preço origem/destino: média ponderada pelo kt do próprio lado/mês.
      // Com meses pareados, as médias usam SÓ esses meses (mesma população
      // dos dois lados) e Var = destino − origem; sem nenhum mês pareado,
      // mostra a média de cada lado isoladamente, sem variação.
      const hasMatched = matchedSrc.length > 0;
      const sourceValue = isPrice
        ? weightedAvg(hasMatched ? matchedSrc : srcPoints)
        : null;
      const targetValue = isPrice
        ? weightedAvg(hasMatched ? matchedTgt : tgtPoints)
        : null;
      const varValue =
        hasMatched && sourceValue != null && targetValue != null
          ? targetValue - sourceValue
          : null;
      outLines.push({
        id: l.id,
        label: l.label,
        ...(sourceValue != null ? { sourceValue } : {}),
        ...(targetValue != null ? { targetValue } : {}),
        ...(varValue != null ? { varValue } : {}),
        ...(isPrice && volumeKt != null ? { volumeKt } : {}),
        impactMusd: impact,
      });
    }
    if (outLines.length === 0) continue;
    out.push({
      id: ind.id,
      sourceId: requested.sourceId,
      targetId: requested.targetId,
      title: ind.title,
      unitLabel: ind.unitLabel,
      totalMusd: outLines.reduce((s, l) => s + l.impactMusd, 0),
      items: itemsByIndicator.get(ind.id) ?? [],
      lines: outLines,
    });
  }
  return out;
}
