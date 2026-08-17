/**
 * Núcleo compartilhado da importação das EXPLICAÇÕES (indicadores de mercado).
 *
 * Formato por VERSÃO (como os indicadores): cada linha da fonte traz o valor
 * de uma linha do indicador (ex.: "Iron ore MB 62% (1m lag)") para uma versão
 * e um mês. A diferença entre cenários e o impacto são calculados pelo painel
 * na leitura, depois da seleção do par — nada de valores pareados.
 *
 * Fonte com duas partes:
 *   - "Explicacoes": versao | periodo | explicacao | linha | valor | kt (opc.)
 *     | tipo (opc.: "preco" ou "valor", padrão "preco") | sentido (opc.: +1 ou
 *     -1, padrão -1 = custo) | unidade (opc.);
 *   - "Itens": explicacao | item — quais itens do bridge (ex.: Fines, Pellets)
 *     abrem cada explicação.
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
  marketIndicatorsTable,
  marketIndicatorLinesTable,
  marketIndicatorValuesTable,
  marketIndicatorItemsTable,
} from "@workspace/db";

export const COLUNAS_EXPLICACOES = [
  "versao",
  "periodo",
  "explicacao",
  "linha",
  "valor",
] as const;
/** Colunas da fato no formato dimensional (propriedades vêm da aba "Linhas"). */
export const COLUNAS_EXPLICACOES_FATO = [
  "versao",
  "periodo",
  "explicacao",
  "linha",
  "valor",
] as const;
/** Colunas da dimensão de linhas (aba "Linhas"). */
export const COLUNAS_LINHAS = ["explicacao", "linha"] as const;
export const COLUNAS_ITENS = ["explicacao", "item"] as const;

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

/** Deriva o id de cenário na convenção do painel. */
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

/**
 * Os valores são armazenados POR MÊS (a fonte é mensal, como as demais fontes
 * do painel); FY e trimestres são derivados na leitura. Rejeita períodos
 * FY/trimestre na importação.
 */
export function exigirMensal(
  id: string,
  campo: string,
  linha: number,
  rotulo: Rotulador,
): string {
  if (!/^fy\d{2}_m\d{2}_/.test(id)) {
    fazErro(rotulo)(
      linha,
      `${campo} deve ser um mês (JAN26..DEC26) — os valores das explicações são ` +
        `armazenados por mês e consolidados pelo painel para FY/trimestre`,
    );
  }
  return id;
}

export type RegistroValor = {
  linha: number;
  scenarioId: string;
  explicacao: string;
  unidade: string | null;
  rotuloLinha: string;
  tipo: "price" | "amount";
  sentido: 1 | -1;
  valor: number;
  kt: number | null;
};

export type RegistroItem = {
  linha: number;
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

function parseTipo(
  v: unknown,
  linha: number,
  erro: ReturnType<typeof fazErro>,
): "price" | "amount" | null {
  if (v === null || v === undefined || v === "") return null;
  const t = String(v).trim().toLowerCase();
  if (t === "preco" || t === "preço" || t === "price") return "price";
  if (t === "valor" || t === "montante" || t === "amount") return "amount";
  erro(linha, `coluna "tipo" inválida: "${String(v)}" (esperado "preco" ou "valor")`);
}

function parseSentido(
  r: Record<string, unknown>,
  linha: number,
  erro: ReturnType<typeof fazErro>,
): 1 | -1 | null {
  const n = numeroOpcional(r, "sentido", linha, erro);
  if (n === null) return null;
  if (n !== 1 && n !== -1) {
    erro(linha, `coluna "sentido" inválida: "${n}" (esperado 1 ou -1)`);
  }
  return n as 1 | -1;
}

/** Linha da dimensão (aba "Linhas"): propriedades de cada linha de explicação. */
export type LinhaDim = {
  linha: number; // posição na fonte
  explicacao: string;
  rotuloLinha: string;
  tipo: "price" | "amount";
  sentido: 1 | -1;
  unidade: string | null;
};

export function validarLinhaDim(
  r: Record<string, unknown>,
  posicao: number,
  rotulo: Rotulador,
): LinhaDim {
  const erro = fazErro(rotulo);
  return {
    linha: posicao,
    explicacao: texto(r, "explicacao", posicao, erro),
    rotuloLinha: texto(r, "linha", posicao, erro),
    tipo: parseTipo(r.tipo, posicao, erro) ?? "price",
    sentido: parseSentido(r, posicao, erro) ?? -1,
    unidade:
      typeof r.unidade === "string" && r.unidade.trim() !== "" ? r.unidade.trim() : null,
  };
}

/**
 * Mescla a dimensão de linhas na fato: cada registro da fato recebe
 * tipo/sentido/unidade da sua linha na dimensão. A chave é COMPOSTA
 * (explicacao + linha): o mesmo rótulo pode existir em explicações
 * diferentes, por isso a fato também precisa trazer a coluna "explicacao".
 * Propriedades repetidas na fato são conferidas contra a dimensão e
 * conflitos interrompem tudo; pares da fato fora da dimensão também.
 */
export function mesclarDimensaoLinhas(
  fato: { registro: Record<string, unknown>; posicao: number }[],
  dims: LinhaDim[],
  rotuloFato: Rotulador,
  rotuloDim: Rotulador,
): { registro: Record<string, unknown>; posicao: number }[] {
  const erroFato = fazErro(rotuloFato);
  const erroDim = fazErro(rotuloDim);
  const chave = (explicacao: string, linha: string) => `${explicacao}\u0000${linha}`;
  const porLinha = new Map<string, LinhaDim>();
  for (const d of dims) {
    const k = chave(d.explicacao, d.rotuloLinha);
    const prev = porLinha.get(k);
    if (prev) {
      erroDim(
        d.linha,
        `linha duplicada na dimensão: "${d.rotuloLinha}" da explicação ` +
          `"${d.explicacao}" (já apareceu em ${rotuloDim(prev.linha)}). ` +
          `No modelo dimensional o par explicação + linha é chave única`,
      );
    }
    porLinha.set(k, d);
  }
  return fato.map(({ registro, posicao }) => {
    const rotuloLinha =
      typeof registro.linha === "string" ? (registro.linha as string).trim() : "";
    const expFato =
      typeof registro.explicacao === "string" && (registro.explicacao as string).trim() !== ""
        ? (registro.explicacao as string).trim()
        : null;
    if (expFato === null) {
      erroFato(
        posicao,
        `coluna "explicacao" vazia — com a aba "Linhas" a fato identifica a ` +
          `linha pelo par explicação + linha`,
      );
    }
    const dim = rotuloLinha === "" ? undefined : porLinha.get(chave(expFato!, rotuloLinha));
    if (!dim) {
      erroFato(
        posicao,
        `linha "${rotuloLinha}" da explicação "${expFato}" não consta na ` +
          `dimensão (aba "Linhas")`,
      );
    }
    const tipoFato = parseTipo(registro.tipo, posicao, erroFato);
    if (tipoFato !== null && tipoFato !== dim!.tipo) {
      erroFato(
        posicao,
        `tipo da fato ("${tipoFato === "amount" ? "valor" : "preco"}") conflita com a ` +
          `dimensão para a linha "${rotuloLinha}"`,
      );
    }
    const sentidoFato = parseSentido(registro, posicao, erroFato);
    if (sentidoFato !== null && sentidoFato !== dim!.sentido) {
      erroFato(
        posicao,
        `sentido da fato (${sentidoFato}) conflita com a dimensão (${dim!.sentido}) ` +
          `para a linha "${rotuloLinha}"`,
      );
    }
    const unidadeFato =
      typeof registro.unidade === "string" && (registro.unidade as string).trim() !== ""
        ? (registro.unidade as string).trim()
        : null;
    if (unidadeFato !== null && unidadeFato !== dim!.unidade) {
      erroFato(
        posicao,
        `unidade da fato ("${unidadeFato}") conflita com a dimensão ` +
          `("${dim!.unidade ?? ""}") para a linha "${rotuloLinha}"`,
      );
    }
    return {
      registro: {
        ...registro,
        explicacao: dim!.explicacao,
        tipo: dim!.tipo === "amount" ? "valor" : "preco",
        sentido: dim!.sentido,
        unidade: dim!.unidade ?? undefined,
      },
      posicao,
    };
  });
}

export function validarLinhaValor(
  r: Record<string, unknown>,
  posicao: number,
  rotulo: Rotulador,
): RegistroValor {
  const erro = fazErro(rotulo);
  const linha = posicao;
  const scenarioId = exigirMensal(
    scenarioIdDe(
      texto(r, "versao", linha, erro),
      texto(r, "periodo", linha, erro),
      linha,
      rotulo,
    ),
    "periodo",
    linha,
    rotulo,
  );
  const valor = r.valor;
  if (typeof valor !== "number" || !Number.isFinite(valor)) {
    erro(linha, `coluna "valor" não numérica: "${String(valor)}"`);
  }
  let tipo: "price" | "amount" = "price";
  if (r.tipo !== null && r.tipo !== undefined && r.tipo !== "") {
    const t = String(r.tipo).trim().toLowerCase();
    if (t === "preco" || t === "preço" || t === "price") tipo = "price";
    else if (t === "valor" || t === "montante" || t === "amount") tipo = "amount";
    else erro(linha, `coluna "tipo" inválida: "${String(r.tipo)}" (esperado "preco" ou "valor")`);
  }
  let sentido: 1 | -1 = -1;
  const sentidoNum = numeroOpcional(r, "sentido", linha, erro);
  if (sentidoNum !== null) {
    if (sentidoNum !== 1 && sentidoNum !== -1) {
      erro(linha, `coluna "sentido" inválida: "${sentidoNum}" (esperado 1 ou -1)`);
    }
    sentido = sentidoNum as 1 | -1;
  }
  const unidade =
    typeof r.unidade === "string" && r.unidade.trim() !== "" ? r.unidade.trim() : null;
  return {
    linha,
    scenarioId,
    explicacao: texto(r, "explicacao", linha, erro),
    unidade,
    rotuloLinha: texto(r, "linha", linha, erro),
    tipo,
    sentido,
    valor: valor as number,
    kt: numeroOpcional(r, "kt", linha, erro),
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
    explicacao: texto(r, "explicacao", linha, erro),
    item: texto(r, "item", linha, erro),
  };
}

export type LinhaIndicador = {
  label: string;
  kind: "price" | "amount";
  direction: 1 | -1;
  sortOrder: number;
  values: { scenarioId: string; value: number; volumeKt: number | null }[];
};

export type IndicadorMercado = {
  title: string;
  unitLabel: string;
  sortOrder: number;
  lines: LinhaIndicador[];
  items: string[];
};

/** Agrupa registros validados por explicação/linha e monta os indicadores. */
export function montarDadosMercado(
  valores: RegistroValor[],
  itens: RegistroItem[],
  rotuloValor: Rotulador,
  rotuloItem: Rotulador,
  // Dimensão de linhas (quando a fonte é dimensional): define a ordem de
  // exibição das explicações e linhas; toda linha da dimensão deve ter
  // pelo menos um valor na fato.
  dims?: LinhaDim[],
  rotuloDim?: Rotulador,
): IndicadorMercado[] {
  const erroValor = fazErro(rotuloValor);
  const erroItem = fazErro(rotuloItem);

  const indicadores = new Map<string, IndicadorMercado>();
  const linhas = new Map<string, LinhaIndicador>();
  const vistoValor = new Set<string>();

  if (dims && dims.length > 0) {
    for (const d of dims) {
      let ind = indicadores.get(d.explicacao);
      if (!ind) {
        ind = {
          title: d.explicacao,
          unitLabel: d.unidade ?? "Price $/t",
          sortOrder: indicadores.size,
          lines: [],
          items: [],
        };
        indicadores.set(d.explicacao, ind);
      } else if (d.unidade && d.unidade !== ind.unitLabel) {
        fazErro(rotuloDim ?? rotuloValor)(
          d.linha,
          `explicação "${d.explicacao}" com unidade inconsistente na dimensão ` +
            `("${ind.unitLabel}" ≠ "${d.unidade}")`,
        );
      }
      const line: LinhaIndicador = {
        label: d.rotuloLinha,
        kind: d.tipo,
        direction: d.sentido,
        sortOrder: ind.lines.length,
        values: [],
      };
      linhas.set(`${d.explicacao}|${d.rotuloLinha}`, line);
      ind.lines.push(line);
    }
  }

  for (const r of valores) {
    let ind = indicadores.get(r.explicacao);
    if (!ind) {
      ind = {
        title: r.explicacao,
        unitLabel: r.unidade ?? "Price $/t",
        sortOrder: indicadores.size,
        lines: [],
        items: [],
      };
      indicadores.set(r.explicacao, ind);
    } else if (r.unidade && r.unidade !== ind.unitLabel) {
      erroValor(
        r.linha,
        `explicação "${r.explicacao}" com unidade inconsistente entre as linhas ` +
          `("${ind.unitLabel}" ≠ "${r.unidade}")`,
      );
    }
    const kl = `${r.explicacao}|${r.rotuloLinha}`;
    let line = linhas.get(kl);
    if (!line) {
      line = {
        label: r.rotuloLinha,
        kind: r.tipo,
        direction: r.sentido,
        sortOrder: ind.lines.length,
        values: [],
      };
      linhas.set(kl, line);
      ind.lines.push(line);
    } else {
      if (line.kind !== r.tipo) {
        erroValor(
          r.linha,
          `linha "${r.rotuloLinha}" da explicação "${r.explicacao}" com tipo ` +
            `inconsistente entre os meses ("${line.kind}" ≠ "${r.tipo}")`,
        );
      }
      if (line.direction !== r.sentido) {
        erroValor(
          r.linha,
          `linha "${r.rotuloLinha}" da explicação "${r.explicacao}" com sentido ` +
            `inconsistente entre os meses (${line.direction} ≠ ${r.sentido})`,
        );
      }
    }
    const kv = `${kl}|${r.scenarioId}`;
    if (vistoValor.has(kv)) {
      erroValor(
        r.linha,
        `valor duplicado para a linha "${r.rotuloLinha}" da explicação ` +
          `"${r.explicacao}" no cenário ${r.scenarioId}`,
      );
    }
    vistoValor.add(kv);
    line.values.push({ scenarioId: r.scenarioId, value: r.valor, volumeKt: r.kt });
  }

  const vistoItem = new Set<string>();
  for (const r of itens) {
    const ind = indicadores.get(r.explicacao);
    if (!ind) {
      erroItem(
        r.linha,
        `item "${r.item}" referencia explicação inexistente "${r.explicacao}"`,
      );
    }
    const ki = `${r.explicacao}|${r.item}`;
    if (vistoItem.has(ki)) {
      erroItem(r.linha, `item "${r.item}" duplicado na explicação "${r.explicacao}"`);
    }
    vistoItem.add(ki);
    ind!.items.push(r.item);
  }

  if (dims && dims.length > 0) {
    for (const d of dims) {
      const line = linhas.get(`${d.explicacao}|${d.rotuloLinha}`);
      if (line && line.values.length === 0) {
        fazErro(rotuloDim ?? rotuloValor)(
          d.linha,
          `linha "${d.rotuloLinha}" da explicação "${d.explicacao}" não tem nenhum ` +
            `valor na fato — remova-a da dimensão ou acrescente os valores`,
        );
      }
    }
  }

  return [...indicadores.values()];
}

/**
 * Confere se todos os cenários mensais referenciados existem no catálogo do
 * painel (a base guarda apenas cenários mensais; FY/Q são derivados na leitura).
 */
export async function conferirCenarios(indicadores: IndicadorMercado[]): Promise<void> {
  const ids = [
    ...new Set(
      indicadores.flatMap((i) => i.lines.flatMap((l) => l.values.map((v) => v.scenarioId))),
    ),
  ];
  if (ids.length === 0) return;
  const todos = await db.select({ id: scenariosTable.id }).from(scenariosTable);
  const conhecidos = new Set(todos.map((r) => r.id));
  const faltando = ids.filter((id) => !conhecidos.has(id));
  if (faltando.length > 0) {
    throw new Error(
      `Cenários não encontrados no catálogo do painel: ${faltando.join(", ")}. ` +
        `Confira versão/período nas abas da planilha.`,
    );
  }
}

/**
 * Substitui TODOS os indicadores de explicação dentro de uma única transação.
 * Também limpa as tabelas legadas (pareadas) para não deixar dados obsoletos.
 */
export async function gravarDadosMercado(indicadores: IndicadorMercado[]): Promise<void> {
  await conferirCenarios(indicadores);
  await db.transaction(async (tx) => {
    await tx.delete(marketIndicatorItemsTable);
    await tx.delete(marketIndicatorValuesTable);
    await tx.delete(marketIndicatorLinesTable);
    await tx.delete(marketIndicatorsTable);
    await tx.delete(marketExplanationItemsTable);
    await tx.delete(marketExplanationLinesTable);
    await tx.delete(marketExplanationsTable);
    for (const ind of indicadores) {
      const [head] = await tx
        .insert(marketIndicatorsTable)
        .values({ title: ind.title, unitLabel: ind.unitLabel, sortOrder: ind.sortOrder })
        .returning({ id: marketIndicatorsTable.id });
      for (const line of ind.lines) {
        const [row] = await tx
          .insert(marketIndicatorLinesTable)
          .values({
            indicatorId: head.id,
            label: line.label,
            kind: line.kind,
            direction: line.direction,
            sortOrder: line.sortOrder,
          })
          .returning({ id: marketIndicatorLinesTable.id });
        await tx.insert(marketIndicatorValuesTable).values(
          line.values.map((v) => ({
            lineId: row.id,
            scenarioId: v.scenarioId,
            value: v.value,
            volumeKt: v.volumeKt,
          })),
        );
      }
      if (ind.items.length > 0) {
        await tx.insert(marketIndicatorItemsTable).values(
          ind.items.map((item) => ({ indicatorId: head.id, item })),
        );
      }
    }
  });
}

export async function fecharConexao(): Promise<void> {
  await pool.end();
}

export function resumoMercado(indicadores: IndicadorMercado[]): string {
  const nLinhas = indicadores.reduce((s, i) => s + i.lines.length, 0);
  const nValores = indicadores.reduce(
    (s, i) => s + i.lines.reduce((a, l) => a + l.values.length, 0),
    0,
  );
  const nItens = indicadores.reduce((s, i) => s + i.items.length, 0);
  return (
    `Validado: ${indicadores.length} explicações | ${nLinhas} linhas | ` +
    `${nValores} valores (versão × mês) | ${nItens} vínculos item × explicação`
  );
}
