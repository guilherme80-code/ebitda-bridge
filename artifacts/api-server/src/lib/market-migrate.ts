/**
 * Conversão do formato LEGADO das explicações (linhas já pareadas por
 * origem×destino, com variação e impacto pré-calculados) para o formato por
 * versão: valores por linha × cenário MENSAL; a diferença e o impacto passam
 * a ser calculados na leitura.
 *
 * Derivações:
 *  - kind: "price" quando a linha legada tem valores de origem/destino;
 *    "amount" quando só tem impacto (ex.: "Forex (contract)").
 *  - direction (+1/-1): inferida do sinal do impacto legado em relação à
 *    variação (custo = -1 por padrão). Linhas de montante usam -1 e guardam
 *    origem = 0 / destino = -impacto, preservando o impacto legado.
 *  - kt: gravado nos dois meses do par (a leitura usa o kt do destino).
 * Conflitos (mesmo indicador/linha/cenário com valores diferentes vindos de
 * pares distintos) interrompem a conversão — nunca gravamos um lado só.
 */
import type {
  MarketExplanation,
  MarketExplanationLine,
  MarketExplanationItem,
} from "@workspace/db";

export type ConvertedIndicator = {
  title: string;
  unitLabel: string;
  sortOrder: number;
  lines: {
    label: string;
    kind: "price" | "amount";
    direction: 1 | -1;
    sortOrder: number;
    values: { scenarioId: string; value: number | null; volumeKt: number | null }[];
  }[];
  items: string[];
};

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export function convertLegacyMarketExplanations(
  heads: MarketExplanation[],
  lines: MarketExplanationLine[],
  items: MarketExplanationItem[],
): ConvertedIndicator[] {
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

  const indicators = new Map<string, ConvertedIndicator>();
  const lineIndex = new Map<string, ConvertedIndicator["lines"][number]>();
  // Direção "inferida" (derivada de var/impacto não nulos) vence a padrão (-1);
  // duas inferências divergentes na mesma linha são um conflito real.
  const directionInferred = new Set<string>();
  // Linhas legadas de montante, para verificar preservação ao final.
  const amountChecks: {
    key: string;
    label: string;
    title: string;
    sourceId: string;
    targetId: string;
    impact: number;
  }[] = [];
  const sortedHeads = [...heads].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  for (const head of sortedHeads) {
    let ind = indicators.get(head.title);
    if (!ind) {
      ind = {
        title: head.title,
        unitLabel: head.unitLabel,
        sortOrder: indicators.size,
        lines: [],
        items: [],
      };
      indicators.set(head.title, ind);
    }
    for (const it of itemsByHead.get(head.id) ?? []) {
      if (!ind.items.includes(it)) ind.items.push(it);
    }
    const headLines = (linesByHead.get(head.id) ?? []).sort(
      (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
    );
    for (const l of headLines) {
      const isPrice = l.sourceValue != null || l.targetValue != null;
      const kind: "price" | "amount" = isPrice ? "price" : "amount";
      // Deriva a direção a partir da diferença EFETIVA (destino − origem),
      // não da variação legada arredondada, quando os dois lados existem.
      let inferred: 1 | -1 | null = null;
      if (isPrice && l.impactMusd !== 0) {
        const diff =
          l.sourceValue != null && l.targetValue != null
            ? l.targetValue - l.sourceValue
            : l.varValue;
        if (diff != null && diff !== 0) {
          inferred = l.impactMusd * diff > 0 ? 1 : -1;
        }
      }
      const key = `${head.title}|${l.label}`;
      let line = lineIndex.get(key);
      if (!line) {
        line = {
          label: l.label,
          kind,
          direction: inferred ?? -1,
          sortOrder: ind.lines.length,
          values: [],
        };
        lineIndex.set(key, line);
        ind.lines.push(line);
        if (inferred != null) directionInferred.add(key);
      } else {
        if (line.kind !== kind) {
          throw new Error(
            `Conversão das explicações: linha "${l.label}" (${head.title}) mistura preço e montante entre os pares`,
          );
        }
        if (inferred != null) {
          if (directionInferred.has(key) && line.direction !== inferred) {
            throw new Error(
              `Conversão das explicações: linha "${l.label}" (${head.title}) com direção ` +
                `inconsistente entre os pares (custo × benefício) — converta manualmente`,
            );
          }
          line.direction = inferred;
          directionInferred.add(key);
        }
      }
      const upsert = (scenarioId: string, value: number | null, volumeKt: number | null) => {
        const cur = line!.values.find((v) => v.scenarioId === scenarioId);
        if (!cur) {
          line!.values.push({ scenarioId, value, volumeKt });
          return;
        }
        const clash =
          (cur.value != null && value != null && !near(cur.value, value)) ||
          (cur.volumeKt != null && volumeKt != null && !near(cur.volumeKt, volumeKt));
        if (clash) {
          throw new Error(
            `Conversão das explicações: valores conflitantes para "${l.label}" (${head.title}) no cenário ${scenarioId}`,
          );
        }
        if (cur.value == null) cur.value = value;
        if (cur.volumeKt == null) cur.volumeKt = volumeKt;
      };
      if (isPrice) {
        upsert(head.sourceId, l.sourceValue ?? null, l.volumeKt ?? null);
        upsert(head.targetId, l.targetValue ?? null, l.volumeKt ?? null);
      } else {
        // Montante: origem 0, destino = -impacto (direction -1 preserva o impacto).
        upsert(head.sourceId, 0, null);
        upsert(head.targetId, -l.impactMusd, null);
        amountChecks.push({
          key,
          label: l.label,
          title: head.title,
          sourceId: head.sourceId,
          targetId: head.targetId,
          impact: l.impactMusd,
        });
      }
    }
  }
  // Verificação de preservação: cada impacto legado de montante deve ser
  // reproduzido pelos níveis convertidos (direction × (destino − origem)).
  // Pares encadeados que reutilizam um cenário podem não ser representáveis
  // como níveis — nesse caso abortamos em vez de gravar valores errados.
  for (const c of amountChecks) {
    const line = lineIndex.get(c.key)!;
    const sv = line.values.find((v) => v.scenarioId === c.sourceId)?.value;
    const tv = line.values.find((v) => v.scenarioId === c.targetId)?.value;
    if (sv == null || tv == null || !near(line.direction * (tv - sv), c.impact)) {
      throw new Error(
        `Conversão das explicações: impacto legado de "${c.label}" (${c.title}) entre ` +
          `${c.sourceId} e ${c.targetId} não é representável por valores por versão — ` +
          `reimporte no novo formato`,
      );
    }
  }
  return [...indicators.values()];
}
