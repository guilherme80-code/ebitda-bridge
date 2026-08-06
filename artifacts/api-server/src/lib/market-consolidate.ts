/**
 * Consolidação das EXPLICAÇÕES (ex.: Iron Ores) — armazenadas por mês, como a
 * fonte. Para um par FY/trimestre, o painel expande o par em pares mensais
 * (mês i da origem ↔ mês i do destino), soma os impactos por explicação e
 * linha, e devolve também o detalhe mês a mês.
 *
 * Regras de consolidação:
 *  - impacto ($m) e volume (kt): somados entre os meses;
 *  - valores de preço (origem/destino/variação): mostrados apenas quando o
 *    par cobre um único mês — somar preços não faz sentido;
 *  - itens vinculados (Fines, Pellets...): união entre os meses;
 *  - unidade: a do primeiro mês (a importação garante consistência por par).
 */
import type {
  MarketExplanation,
  MarketExplanationLine,
  MarketExplanationItem,
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

function toLineOut(l: MarketExplanationLine): LineOut {
  return {
    id: l.id,
    label: l.label,
    ...(l.sourceValue != null ? { sourceValue: l.sourceValue } : {}),
    ...(l.targetValue != null ? { targetValue: l.targetValue } : {}),
    ...(l.varValue != null ? { varValue: l.varValue } : {}),
    ...(l.volumeKt != null ? { volumeKt: l.volumeKt } : {}),
    impactMusd: l.impactMusd,
  };
}

/**
 * Consolida as explicações dos pares mensais do intervalo pedido. `heads`,
 * `lines` e `items` são as linhas cruas do banco para esses pares.
 */
export function consolidateMarketExplanations(
  requested: { sourceId: string; targetId: string },
  pairs: MonthPair[],
  heads: MarketExplanation[],
  lines: MarketExplanationLine[],
  items: MarketExplanationItem[],
): ConsolidatedExplanation[] {
  const linesByHead = new Map<number, MarketExplanationLine[]>();
  for (const l of lines) {
    const arr = linesByHead.get(l.explanationId) ?? [];
    arr.push(l);
    linesByHead.set(l.explanationId, arr);
  }
  const itemsByHead = new Map<number, string[]>();
  for (const i of items) {
    const arr = itemsByHead.get(i.explanationId) ?? [];
    arr.push(i.item);
    itemsByHead.set(i.explanationId, arr);
  }
  const pairKey = (s: string, t: string) => `${s}→${t}`;
  const pairIndex = new Map(pairs.map((p, i) => [pairKey(p.sourceId, p.targetId), i]));

  // Agrupa cabeçalhos por título, na ordem (sortOrder, id) do primeiro mês.
  type Group = { title: string; heads: { head: MarketExplanation; monthIdx: number }[] };
  const groups = new Map<string, Group>();
  const sortedHeads = [...heads].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  for (const h of sortedHeads) {
    const idx = pairIndex.get(pairKey(h.sourceId, h.targetId));
    if (idx === undefined) continue;
    const g = groups.get(h.title) ?? { title: h.title, heads: [] };
    g.heads.push({ head: h, monthIdx: idx });
    groups.set(h.title, g);
  }

  const out: ConsolidatedExplanation[] = [];
  for (const g of groups.values()) {
    g.heads.sort((a, b) => a.monthIdx - b.monthIdx);
    const first = g.heads[0].head;
    const singleMonth = pairs.length === 1;

    const months = g.heads.map(({ head, monthIdx }) => {
      const myLines = (linesByHead.get(head.id) ?? []).sort(
        (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
      );
      return {
        periodLabel: pairs[monthIdx].label,
        totalMusd: myLines.reduce((s, l) => s + l.impactMusd, 0),
        lines: myLines.map(toLineOut),
      };
    });

    // Linhas consolidadas: por rótulo, na ordem da primeira aparição.
    const byLabel = new Map<string, { line: LineOut; ktSeen: boolean }>();
    for (const m of months) {
      for (const l of m.lines) {
        const cur = byLabel.get(l.label);
        if (!cur) {
          byLabel.set(l.label, {
            line: singleMonth
              ? { ...l }
              : {
                  id: l.id,
                  label: l.label,
                  ...(l.volumeKt != null ? { volumeKt: l.volumeKt } : {}),
                  impactMusd: l.impactMusd,
                },
            ktSeen: l.volumeKt != null,
          });
        } else {
          cur.line.impactMusd += l.impactMusd;
          if (l.volumeKt != null) {
            cur.line.volumeKt = (cur.line.volumeKt ?? 0) + l.volumeKt;
            cur.ktSeen = true;
          }
        }
      }
    }
    const consolidated = [...byLabel.values()].map((c) => c.line);
    const itemSet = new Set<string>();
    for (const { head } of g.heads) {
      for (const it of itemsByHead.get(head.id) ?? []) itemSet.add(it);
    }
    out.push({
      id: first.id,
      sourceId: requested.sourceId,
      targetId: requested.targetId,
      title: g.title,
      unitLabel: first.unitLabel,
      totalMusd: months.reduce((s, m) => s + m.totalMusd, 0),
      items: [...itemSet],
      lines: consolidated,
      months,
    });
  }
  return out;
}
