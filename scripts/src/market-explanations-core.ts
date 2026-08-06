/**
 * Núcleo compartilhado da importação de EXPLICAÇÕES DE MERCADO.
 *
 * Fonte com duas partes:
 *   - "Explicacoes": linhas das tabelas de mercado (ex.: Iron Ores), com
 *     valores do cenário origem/destino, variação, volume (kt) e impacto ($m),
 *     por par de cenários;
 *   - "Itens": relação Item × Explicação — quais itens do bridge (ex.: Fines,
 *     Pellets, Lumps) são impactados por cada explicação.
 *
 * Erros de formato interrompem tudo apontando a linha problemática; nada é
 * gravado fora da transação. Mesmo padrão do indicadores-core.ts.
 */
import {
  db,
  pool,
  scenariosTable,
  marketExplanationsTable,
  marketExplanationLinesTable,
  marketExplanationItemsTable,
  type InsertMarketExplanation,
  type InsertMarketExplanationLine,
  type InsertMarketExplanationItem,
} from "@workspace/db";

export const COLUNAS_EXPLICACOES = [
  "versao_origem",
  "periodo_origem",
  "versao_destino",
  "periodo_destino",
  "explicacao",
  "linha",
  "impacto_musd",
] as const;
export const COLUNAS_ITENS = [
  "versao_origem",
  "periodo_origem",
  "versao_destino",
  "periodo_destino",
  "explicacao",
  "item",
] as const;

const VERSIONS = [
  "ACTUAL",
  "BUDGET",
  "MRF1",
  "MRF2",
  "MRF3",
  "MRF4",
  "MRF5",
  "MRF6",
  "MRF7",
];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export type Rotulador = (posicao: number) => string;

function fazErro(rotulo: Rotulador) {
  return function erro(posicao: number, msg: string): never {
    throw new Error(`${rotulo(posicao)}: ${msg}`);
  };
}

/** Deriva o id de cenário na convenção do painel. Diferente da fonte de
 *  indicadores (mensal), explicações de mercado podem referenciar qualquer
 *  granularidade — FY26, Q126..Q426 ou JAN26..DEC26 — pois os cenários FY e
 *  trimestrais são derivados pelo painel e têm ids próprios. */
export function scenarioIdDe(
  versao: string,
  periodo: string,
  linha: number,
  rotulo: Rotulador,
): string {
  const erro = fazErro(rotulo);
  const canonica = versao.trim().toUpperCase().replace(/^MRF0(\d)$/, "MRF$1");
  if (!VERSIONS.includes(canonica)) {
    erro(linha, `versao desconhecida: "${versao}" (esperado ${VERSIONS.join(", ")})`);
  }
  const vSlug = canonica.toLowerCase();
  const p = periodo.trim().toUpperCase();
  const fy = p.match(/^FY(\d{2})$/);
  if (fy) return `fy${fy[1]}_fy_${vSlug}`;
  const q = p.match(/^Q([1-4])(\d{2})$/);
  if (q) return `fy${q[2]}_q${q[1]}_${vSlug}`;
  const mi = MONTHS.indexOf(p.slice(0, 3));
  if (mi >= 0 && /^\d{2}$/.test(p.slice(3))) {
    return `fy${p.slice(3)}_m${String(mi + 1).padStart(2, "0")}_${vSlug}`;
  }
  throw new Error(
    `${rotulo(linha)}: periodo desconhecido: "${periodo}" (esperado FY26, Q126..Q426 ou JAN26..DEC26)`,
  );
}

export type RegistroExplicacao = {
  linha: number;
  sourceId: string;
  targetId: string;
  explicacao: string;
  unidade: string | null;
  rotuloLinha: string;
  valorOrigem: number | null;
  valorDestino: number | null;
  variacao: number | null;
  kt: number | null;
  impactoMusd: number;
};

export type RegistroItem = {
  linha: number;
  sourceId: string;
  targetId: string;
  explicacao: string;
  item: string;
};

function texto(
  r: Record<string, unknown>,
  col: string,
  linha: number,
  erro: ReturnType<typeof fazErro>,
): string {
  const v = r[col];
  if (typeof v !== "string" || v.trim() === "") erro(linha, `coluna "${col}" vazia`);
  return (v as string).trim();
}

function numeroOpcional(
  r: Record<string, unknown>,
  col: string,
  linha: number,
  erro: ReturnType<typeof fazErro>,
): number | null {
  const v = r[col];
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    erro(linha, `coluna "${col}" não numérica: "${String(v)}"`);
  }
  return v as number;
}

export function validarLinhaExplicacao(
  r: Record<string, unknown>,
  posicao: number,
  rotulo: Rotulador,
): RegistroExplicacao {
  const erro = fazErro(rotulo);
  const linha = posicao;
  const sourceId = scenarioIdDe(
    texto(r, "versao_origem", linha, erro),
    texto(r, "periodo_origem", linha, erro),
    linha,
    rotulo,
  );
  const targetId = scenarioIdDe(
    texto(r, "versao_destino", linha, erro),
    texto(r, "periodo_destino", linha, erro),
    linha,
    rotulo,
  );
  if (sourceId === targetId) {
    erro(linha, `cenários de origem e destino iguais (${sourceId})`);
  }
  const impacto = r.impacto_musd;
  if (typeof impacto !== "number" || !Number.isFinite(impacto)) {
    erro(linha, `coluna "impacto_musd" não numérica: "${String(impacto)}"`);
  }
  const unidade =
    typeof r.unidade === "string" && r.unidade.trim() !== "" ? r.unidade.trim() : null;
  return {
    linha,
    sourceId,
    targetId,
    explicacao: texto(r, "explicacao", linha, erro),
    unidade,
    rotuloLinha: texto(r, "linha", linha, erro),
    valorOrigem: numeroOpcional(r, "valor_origem", linha, erro),
    valorDestino: numeroOpcional(r, "valor_destino", linha, erro),
    variacao: numeroOpcional(r, "variacao", linha, erro),
    kt: numeroOpcional(r, "kt", linha, erro),
    impactoMusd: impacto as number,
  };
}

export function validarLinhaItem(
  r: Record<string, unknown>,
  posicao: number,
  rotulo: Rotulador,
): RegistroItem {
  const erro = fazErro(rotulo);
  const linha = posicao;
  return {
    linha,
    sourceId: scenarioIdDe(
      texto(r, "versao_origem", linha, erro),
      texto(r, "periodo_origem", linha, erro),
      linha,
      rotulo,
    ),
    targetId: scenarioIdDe(
      texto(r, "versao_destino", linha, erro),
      texto(r, "periodo_destino", linha, erro),
      linha,
      rotulo,
    ),
    explicacao: texto(r, "explicacao", linha, erro),
    item: texto(r, "item", linha, erro),
  };
}

export type DadosMercado = {
  explanations: InsertMarketExplanation[];
  // linhas e itens indexados pela posição da explicação em `explanations`
  lines: (InsertMarketExplanationLine & { explanationIndex: number })[];
  items: (InsertMarketExplanationItem & { explanationIndex: number })[];
};

/** Agrupa registros validados por (par, explicação) e monta os inserts. */
export function montarDadosMercado(
  explicacoes: RegistroExplicacao[],
  itens: RegistroItem[],
  rotuloExplicacao: Rotulador,
  rotuloItem: Rotulador,
): DadosMercado {
  const erroItem = fazErro(rotuloItem);
  const erroExp = fazErro(rotuloExplicacao);

  const chave = (sourceId: string, targetId: string, titulo: string) =>
    `${sourceId}→${targetId}|${titulo}`;

  const explanations: InsertMarketExplanation[] = [];
  const indexPorChave = new Map<string, number>();
  const lines: DadosMercado["lines"] = [];
  const vistoLinha = new Set<string>();

  for (const r of explicacoes) {
    const k = chave(r.sourceId, r.targetId, r.explicacao);
    let idx = indexPorChave.get(k);
    if (idx === undefined) {
      idx = explanations.length;
      indexPorChave.set(k, idx);
      explanations.push({
        sourceId: r.sourceId,
        targetId: r.targetId,
        title: r.explicacao,
        unitLabel: r.unidade ?? "Price $/t",
        sortOrder: idx,
      });
    } else if (r.unidade && r.unidade !== explanations[idx].unitLabel) {
      erroExp(
        r.linha,
        `explicação "${r.explicacao}" com unidade inconsistente entre as linhas ` +
          `("${explanations[idx].unitLabel}" ≠ "${r.unidade}")`,
      );
    }
    const kl = `${k}|${r.rotuloLinha}`;
    if (vistoLinha.has(kl)) {
      erroExp(r.linha, `linha "${r.rotuloLinha}" duplicada na explicação "${r.explicacao}"`);
    }
    vistoLinha.add(kl);
    lines.push({
      explanationIndex: idx,
      explanationId: 0, // resolvido na gravação
      label: r.rotuloLinha,
      sourceValue: r.valorOrigem,
      targetValue: r.valorDestino,
      varValue: r.variacao,
      volumeKt: r.kt,
      impactMusd: r.impactoMusd,
      sortOrder: lines.filter((l) => l.explanationIndex === idx).length,
    });
  }

  const items: DadosMercado["items"] = [];
  const vistoItem = new Set<string>();
  for (const r of itens) {
    const k = chave(r.sourceId, r.targetId, r.explicacao);
    const idx = indexPorChave.get(k);
    if (idx === undefined) {
      erroItem(
        r.linha,
        `item "${r.item}" referencia explicação inexistente "${r.explicacao}" ` +
          `para o par ${r.sourceId} → ${r.targetId}`,
      );
    }
    const ki = `${k}|${r.item}`;
    if (vistoItem.has(ki)) {
      erroItem(r.linha, `item "${r.item}" duplicado na explicação "${r.explicacao}"`);
    }
    vistoItem.add(ki);
    items.push({ explanationIndex: idx!, explanationId: 0, item: r.item });
  }

  return { explanations, lines, items };
}

/**
 * Confere se todos os cenários referenciados existem no catálogo do painel.
 * A base guarda apenas cenários mensais; ids FY/Q são derivados pelo painel,
 * então para eles basta existir ao menos um mês da mesma versão/ano.
 */
export async function conferirCenarios(d: DadosMercado): Promise<void> {
  const ids = [
    ...new Set(d.explanations.flatMap((e) => [e.sourceId, e.targetId])),
  ];
  if (ids.length === 0) return;
  const todos = await db.select({ id: scenariosTable.id }).from(scenariosTable);
  const conhecidos = new Set(todos.map((r) => r.id));
  const existe = (id: string): boolean => {
    if (conhecidos.has(id)) return true;
    const derivado = id.match(/^fy(\d{2})_(?:fy|q[1-4])_(.+)$/);
    if (!derivado) return false;
    const prefixo = `fy${derivado[1]}_m`;
    const sufixo = `_${derivado[2]}`;
    return todos.some((r) => r.id.startsWith(prefixo) && r.id.endsWith(sufixo));
  };
  const faltando = ids.filter((id) => !existe(id));
  if (faltando.length > 0) {
    throw new Error(
      `Cenários não encontrados no catálogo do painel: ${faltando.join(", ")}. ` +
        `Confira versão/período nas abas da planilha.`,
    );
  }
}

/** Substitui TODAS as explicações de mercado dentro de uma única transação. */
export async function gravarDadosMercado(d: DadosMercado): Promise<void> {
  await conferirCenarios(d);
  await db.transaction(async (tx) => {
    await tx.delete(marketExplanationItemsTable);
    await tx.delete(marketExplanationLinesTable);
    await tx.delete(marketExplanationsTable);
    const ids: number[] = [];
    for (const e of d.explanations) {
      const [row] = await tx
        .insert(marketExplanationsTable)
        .values(e)
        .returning({ id: marketExplanationsTable.id });
      ids.push(row.id);
    }
    if (d.lines.length > 0) {
      await tx.insert(marketExplanationLinesTable).values(
        d.lines.map(({ explanationIndex, ...l }) => ({
          ...l,
          explanationId: ids[explanationIndex],
        })),
      );
    }
    if (d.items.length > 0) {
      await tx.insert(marketExplanationItemsTable).values(
        d.items.map(({ explanationIndex, ...i }) => ({
          ...i,
          explanationId: ids[explanationIndex],
        })),
      );
    }
  });
}

export async function fecharConexao(): Promise<void> {
  await pool.end();
}

export function resumoMercado(d: DadosMercado): string {
  return (
    `Validado: ${d.explanations.length} explicações | ` +
    `${d.lines.length} linhas | ${d.items.length} vínculos item × explicação`
  );
}
