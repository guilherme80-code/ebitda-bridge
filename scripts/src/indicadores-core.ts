/**
 * Núcleo compartilhado da importação de indicadores (docs/modelo-indicadores.md).
 *
 * As mesmas validações servem para duas fontes:
 *   - a aba única "Indicadores" do Excel (import-indicadores.ts)
 *   - a tabela do Databricks com as mesmas colunas (import-databricks.ts)
 *
 * Cada linha/registro: versao | periodo | secao | item | indicador | valor | moeda | atributo
 * Erros de formato interrompem tudo apontando a linha/registro problemático;
 * nada é gravado fora da transação.
 */
import {
  db,
  pool,
  scenariosTable,
  scenarioParamsTable,
  salesFactsTable,
  fixedCostFactsTable,
  inputPriceFactsTable,
  miscFactsTable,
  dimItemsTable,
  indicatorFactsTable,
  type InsertScenario,
  type InsertScenarioParams,
  type InsertSalesFact,
  type InsertFixedCostFact,
  type InsertInputPriceFact,
  type InsertMiscFact,
  type InsertDimItem,
  type InsertIndicatorFact,
} from "@workspace/db";

export const COLUNAS = ["versao", "periodo", "secao", "item", "indicador", "valor"] as const;
/** Colunas da fato no formato dimensional (propriedades vêm da dimensão). */
export const COLUNAS_FATO = ["versao", "periodo", "item", "indicador", "valor"] as const;
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

/**
 * Interpreta um período mensal nos dois formatos aceitos:
 *   - `YYYYMM` (padrão SAP SAC, canônico): "202601" = jan/2026;
 *   - `MMMYY` (formato antigo, retrocompatível): "JAN26".
 * Retorna { mi (0-11), yy ("26") } ou null quando não é nenhum dos dois.
 * Lança via `erro` quando o formato é YYYYMM mas mês/ano são inválidos.
 */
export function parsePeriodoMensal(
  periodo: string,
  linha: number,
  erro: (posicao: number, msg: string) => never,
): { mi: number; yy: string } | null {
  const p = periodo.trim().toUpperCase();
  const ym = p.match(/^(\d{4})(\d{2})$/);
  if (ym) {
    const ano = Number(ym[1]);
    const mes = Number(ym[2]);
    if (mes < 1 || mes > 12) {
      erro(linha, `periodo "${periodo}": mês inválido no formato YYYYMM (esperado 01..12)`);
    }
    if (ano < 2000 || ano > 2099) {
      erro(linha, `periodo "${periodo}": ano fora do esperado no formato YYYYMM (esperado 2000..2099)`);
    }
    return { mi: mes - 1, yy: ym[1].slice(2) };
  }
  const mi = MONTHS.indexOf(p.slice(0, 3));
  if (mi >= 0 && /^\d{2}$/.test(p.slice(3))) return { mi, yy: p.slice(3) };
  return null;
}

/** Converte o período interno mensal ("JAN26") para o padrão SAC "YYYYMM". */
export function periodoParaYYYYMM(period: string): string {
  const p = period.trim().toUpperCase();
  if (/^\d{6}$/.test(p)) return p; // já está no padrão
  const mi = MONTHS.indexOf(p.slice(0, 3));
  if (mi < 0 || !/^\d{2}$/.test(p.slice(3))) {
    throw new Error(`Período mensal inesperado: "${period}" (esperado JAN26..DEC26)`);
  }
  return `20${p.slice(3)}${String(mi + 1).padStart(2, "0")}`;
}

const INDICADORES: Record<string, Set<string>> = {
  Parametros: new Set([
    "cambio_brl_usd",
    "cambio_custo_fixo_brl_usd",
    "aco_bruto_kt",
    "ebitda_kusd",
    "participacao_custo_interno",
  ]),
  Vendas: new Set(["quantidade_kt", "montante_kusd", "custo_variavel_kusd"]),
  CustoFixo: new Set(["montante_kusd"]),
  Insumos: new Set(["preco_usd_t", "fator_rendimento", "montante_kusd"]),
  Ajustes: new Set(["montante_kusd"]),
};
const ATRIBUTO_TO_DRIVER: Record<string, string> = {
  consumo: "usage",
  outros: "others",
  variacao_estoque: "stock_variation",
};

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Linha da dimensão de itens (aba "Itens" / tabela dim do Databricks). */
export type ItemDim = {
  linha: number;
  item: string;
  secao: string;
  moeda: string | null;
  atributo: string | null;
  grupo: string | null;
};

export const COLUNAS_ITENS = ["item", "secao"] as const;

/**
 * Ordena as linhas cruas da dimensão pela coluna ordinal "sort_order".
 * Tabelas SQL (Databricks) não têm ordem inerente — lá a coluna é
 * OBRIGATÓRIA; no Excel a ordem das linhas da planilha já é determinística e
 * a coluna é opcional (quando presente, prevalece sobre a ordem das linhas).
 * Valores devem ser numéricos e únicos; qualquer violação interrompe tudo.
 */
export function ordenarDimensao(
  rows: { registro: Record<string, unknown>; posicao: number }[],
  rotulo: Rotulador,
  obrigatoria: boolean,
): { registro: Record<string, unknown>; posicao: number }[] {
  const erro = fazErro(rotulo);
  const bruto = (r: Record<string, unknown>): unknown => r["sort_order"];
  const presentes = rows.filter(({ registro }) => {
    const v = bruto(registro);
    return v !== null && v !== undefined && String(v).trim() !== "";
  });
  if (presentes.length === 0) {
    if (obrigatoria) {
      throw new Error(
        `Coluna "sort_order" ausente na dimensão: em tabelas SQL a ordem de ` +
          `retorno não é determinística — inclua a coluna ordinal para fixar ` +
          `a ordem de exibição dos itens`,
      );
    }
    return rows;
  }
  const vistos = new Map<number, number>();
  const chaves = rows.map(({ registro, posicao }) => {
    const v = bruto(registro);
    if (v === null || v === undefined || String(v).trim() === "") {
      erro(posicao, `coluna "sort_order" vazia (presente nas demais linhas da dimensão)`);
    }
    const n = Number(v);
    if (!Number.isFinite(n)) {
      erro(posicao, `coluna "sort_order" não numérica: "${String(v)}"`);
    }
    const prev = vistos.get(n);
    if (prev !== undefined) {
      erro(posicao, `coluna "sort_order" duplicada (${n}, já usada em ${rotulo(prev)})`);
    }
    vistos.set(n, posicao);
    return n;
  });
  return rows
    .map((r, i) => ({ r, k: chaves[i] }))
    .sort((a, b) => a.k - b.k)
    .map(({ r }) => r);
}

/** Valida uma linha da dimensão de itens. */
export function validarItemDim(
  r: Record<string, unknown>,
  posicao: number,
  rotulo: Rotulador,
): ItemDim {
  const erro = fazErro(rotulo);
  const texto = (col: string): string => {
    const v = r[col];
    if (typeof v !== "string" || v.trim() === "") erro(posicao, `coluna "${col}" vazia`);
    return (v as string).trim();
  };
  const secao = texto("secao");
  if (!INDICADORES[secao]) {
    erro(posicao, `secao desconhecida: "${secao}" (esperado ${Object.keys(INDICADORES).join(", ")})`);
  }
  const opcional = (col: string): string | null =>
    typeof r[col] === "string" && (r[col] as string).trim() !== ""
      ? (r[col] as string).trim()
      : null;
  return {
    linha: posicao,
    item: texto("item"),
    secao,
    moeda: opcional("moeda"),
    atributo: opcional("atributo"),
    grupo: opcional("grupo"),
  };
}

/**
 * Mescla a dimensão de itens nas linhas da fato: cada linha da fato recebe as
 * propriedades (secao/moeda/atributo/grupo) do seu item na dimensão.
 * Se a fato trouxer essas colunas repetidas, elas são conferidas contra a
 * dimensão e qualquer conflito interrompe a importação. Itens da fato fora
 * da dimensão também interrompem.
 */
export function mesclarDimensao(
  fato: { registro: Record<string, unknown>; posicao: number }[],
  dims: ItemDim[],
  rotuloFato: Rotulador,
  rotuloDim: Rotulador,
): { registro: Record<string, unknown>; posicao: number }[] {
  const erroFato = fazErro(rotuloFato);
  const erroDim = fazErro(rotuloDim);
  const porItem = new Map<string, ItemDim>();
  for (const d of dims) {
    const prev = porItem.get(d.item);
    if (prev) {
      erroDim(d.linha, `item duplicado na dimensão: "${d.item}" (já apareceu em ${rotuloDim(prev.linha)})`);
    }
    porItem.set(d.item, d);
  }
  const PROPS = ["secao", "moeda", "atributo", "grupo"] as const;
  return fato.map(({ registro, posicao }) => {
    const item = typeof registro.item === "string" ? registro.item.trim() : "";
    const dim = item === "" ? undefined : porItem.get(item);
    if (!dim) {
      erroFato(posicao, `item "${item}" não consta na dimensão de itens (aba/tabela Itens)`);
    }
    const merged: Record<string, unknown> = { ...registro };
    for (const p of PROPS) {
      const daFato =
        typeof registro[p] === "string" && (registro[p] as string).trim() !== ""
          ? (registro[p] as string).trim()
          : null;
      const daDim = dim![p];
      if (daFato !== null && daFato !== daDim) {
        erroFato(
          posicao,
          `propriedade "${p}" da fato ("${daFato}") conflita com a dimensão ` +
            `("${daDim ?? ""}") para o item "${item}"`,
        );
      }
      merged[p] = daDim ?? undefined;
    }
    return { registro: merged, posicao };
  });
}

export type Registro = {
  linha: number; // posição na fonte (linha da planilha ou nº do registro)
  versao: string;
  periodo: string;
  secao: string;
  item: string;
  indicador: string;
  valor: number;
  moeda: string | null;
  atributo: string | null;
  grupo: string | null;
};

/** Como apontar a posição do problema na mensagem de erro:
 *  "Linha N" para planilha, "Registro N" para tabela do Databricks. */
export type Rotulador = (posicao: number) => string;

export function fazErro(rotulo: Rotulador) {
  return function erro(posicao: number, msg: string): never {
    throw new Error(`${rotulo(posicao)}: ${msg}`);
  };
}

/** Deriva id, tipo de período, rótulo e ordenação do cenário (mesma convenção
 *  do painel: fy26_fy_budget, fy26_q1_mrf3, fy26_m01_mrf7...). */
function scenarioMeta(
  versao: string,
  periodo: string,
  linha: number,
  erro: ReturnType<typeof fazErro>,
) {
  // MRF01..MRF09 são normalizados para MRF1..MRF9 (mesma convenção de ids).
  const canonica = versao.replace(/^MRF0(\d)$/, "MRF$1");
  const vi = VERSIONS.indexOf(canonica);
  if (vi < 0) erro(linha, `versao desconhecida: "${versao}" (esperado ${VERSIONS.join(", ")})`);
  const vSlug = canonica.toLowerCase();
  const vLabel =
    canonica === "BUDGET" ? "Budget" : canonica === "ACTUAL" ? "Actual" : canonica;

  if (/^FY\d{2}$/.test(periodo) || /^Q[1-4]\d{2}$/.test(periodo)) {
    erro(
      linha,
      `periodo "${periodo}" não é mais aceito: a fonte é mensal (YYYYMM, ex.: 202601). ` +
        `FY e trimestres são consolidados pelo painel a partir dos meses`,
    );
  }
  const pm = parsePeriodoMensal(periodo, linha, erro);
  if (pm) {
    const rotuloMes = `${MONTHS[pm.mi]}${pm.yy}`;
    return {
      id: `fy${pm.yy}_m${String(pm.mi + 1).padStart(2, "0")}_${vSlug}`,
      periodKind: "month",
      label: `${rotuloMes} ${vLabel}`,
      versao: canonica,
      sortOrder: 10000 + (vi + 1) * 100 + pm.mi,
    };
  }
  erro(linha, `periodo desconhecido: "${periodo}" (esperado YYYYMM, ex.: 202601; JAN26..DEC26 também é aceito)`);
}

/**
 * Valida uma linha crua da fonte e devolve o registro normalizado.
 * `posicao` é a posição informada nas mensagens de erro (via `rotulo`).
 */
export function validarLinha(
  r: Record<string, unknown>,
  posicao: number,
  rotulo: Rotulador,
): Registro {
  const erro = fazErro(rotulo);
  const linha = posicao;
  const texto = (col: string): string => {
    const v = r[col];
    if (typeof v !== "string" || v.trim() === "") erro(linha, `coluna "${col}" vazia`);
    return (v as string).trim();
  };
  const secao = texto("secao");
  if (!INDICADORES[secao]) {
    erro(linha, `secao desconhecida: "${secao}" (esperado ${Object.keys(INDICADORES).join(", ")})`);
  }
  const indicador = texto("indicador");
  if (!INDICADORES[secao].has(indicador)) {
    erro(
      linha,
      `indicador "${indicador}" não é válido na seção ${secao} ` +
        `(esperado ${[...INDICADORES[secao]].join(", ")})`,
    );
  }
  const valor = r.valor;
  if (typeof valor !== "number" || !Number.isFinite(valor)) {
    erro(linha, `valor não numérico: "${String(valor)}"`);
  }
  const moeda = typeof r.moeda === "string" && r.moeda.trim() !== "" ? r.moeda.trim() : null;
  if (moeda && moeda !== "BRL" && moeda !== "USD") {
    erro(linha, `moeda inválida: "${moeda}" (esperado BRL ou USD)`);
  }
  const atributo =
    typeof r.atributo === "string" && r.atributo.trim() !== "" ? r.atributo.trim() : null;
  if (secao === "Ajustes" && (!atributo || !ATRIBUTO_TO_DRIVER[atributo])) {
    erro(
      linha,
      `Ajustes exige atributo consumo, outros ou variacao_estoque (recebido: "${atributo ?? ""}")`,
    );
  }
  if (secao === "Vendas") {
    if (!moeda) erro(linha, `Vendas exige moeda BRL ou USD`);
    if (atributo !== "interno" && atributo !== "externo") {
      erro(linha, `Vendas exige atributo interno ou externo (recebido: "${atributo ?? ""}")`);
    }
  }
  if (secao === "CustoFixo" && !moeda) erro(linha, `CustoFixo exige moeda BRL ou USD`);
  const grupo =
    typeof r.grupo === "string" && r.grupo.trim() !== "" ? r.grupo.trim() : null;
  if (grupo && secao === "Parametros") {
    erro(linha, `grupo não se aplica à seção Parametros (recebido: "${grupo}")`);
  }
  // Período: aceita YYYYMM (padrão SAC; células numéricas do Excel inclusas)
  // e MMMYY (formato antigo). Normaliza para o formato interno MMMYY — assim
  // scenarios.period e os rótulos do painel não mudam.
  const periodoBruto =
    typeof r.periodo === "number" && Number.isFinite(r.periodo)
      ? String(r.periodo)
      : texto("periodo");
  const pm = parsePeriodoMensal(periodoBruto, linha, erro);
  const periodo = pm ? `${MONTHS[pm.mi]}${pm.yy}` : periodoBruto;
  return {
    linha,
    versao: texto("versao"),
    periodo,
    secao,
    item: texto("item"),
    indicador,
    valor: valor as number,
    moeda,
    atributo,
    grupo,
  };
}

export type Dados = {
  scenarios: InsertScenario[];
  params: InsertScenarioParams[];
  sales: InsertSalesFact[];
  fixed: InsertFixedCostFact[];
  inputs: InsertInputPriceFact[];
  misc: InsertMiscFact[];
  // Modelo dimensional (fonte canônica gravada no banco).
  dims: InsertDimItem[];
  facts: InsertIndicatorFact[];
};

/**
 * Deriva a dimensão de itens e a fato enxuta dos registros validados.
 * No modelo dimensional o item é chave global: as propriedades devem ser
 * idênticas em TODOS os cenários (versões e meses) — conflitos interrompem.
 */
function montarDimensional(
  registros: Registro[],
  scenarioIdDe: (r: Registro) => string,
  rotulo: Rotulador,
  // Dimensão vinda da aba/tabela "Itens": quando presente, ELA é a fonte da
  // verdade — todos os seus membros são gravados na ordem da planilha,
  // inclusive itens ainda sem nenhum valor na fato (dimensões legitimamente
  // têm membros antes de os dados chegarem).
  dimensao?: ItemDim[],
): { dims: InsertDimItem[]; facts: InsertIndicatorFact[] } {
  const erro = fazErro(rotulo);
  const posDim = new Map<string, number>();
  dimensao?.forEach((d, i) => {
    if (!posDim.has(d.item)) posDim.set(d.item, i);
  });
  const dims = new Map<string, { reg: Registro; ordem: number }>();
  const facts: InsertIndicatorFact[] = [];
  for (const r of registros) {
    if (dimensao && !posDim.has(r.item)) {
      erro(r.linha, `item "${r.item}" não consta na dimensão (aba/tabela "Itens")`);
    }
    const prev = dims.get(r.item);
    if (!prev) {
      dims.set(r.item, { reg: r, ordem: posDim.get(r.item) ?? dims.size });
    } else {
      const p = prev.reg;
      if (
        p.secao !== r.secao ||
        p.moeda !== r.moeda ||
        p.atributo !== r.atributo ||
        p.grupo !== r.grupo
      ) {
        erro(
          r.linha,
          `item "${r.item}" com propriedades inconsistentes entre linhas ` +
            `(${rotulo(p.linha)}: ${p.secao}/${p.moeda ?? ""}/${p.atributo ?? ""}/${p.grupo ?? ""}; ` +
            `esta: ${r.secao}/${r.moeda ?? ""}/${r.atributo ?? ""}/${r.grupo ?? ""}). ` +
            `No modelo dimensional o item é chave única com as mesmas propriedades em todos os cenários`,
        );
      }
    }
    facts.push({
      scenarioId: scenarioIdDe(r),
      item: r.item,
      indicador: r.indicador,
      valor: r.valor,
    });
  }
  // Com a dimensão presente, TODOS os seus membros são gravados na ordem da
  // planilha — inclusive os que ainda não têm valores na fato.
  const dimsOut: InsertDimItem[] = dimensao
    ? dimensao.map((d, i) => ({
        item: d.item,
        secao: d.secao,
        moeda: d.moeda,
        atributo: d.atributo,
        grupo: d.grupo,
        sortOrder: i,
      }))
    : [...dims.values()].map(({ reg, ordem }) => ({
        item: reg.item,
        secao: reg.secao,
        moeda: reg.moeda,
        atributo: reg.atributo,
        grupo: reg.grupo,
        sortOrder: ordem,
      }));
  return { dims: dimsOut, facts };
}

/** Agrupa registros validados por cenário e monta os inserts, aplicando as
 *  validações de consistência (duplicados, obrigatórios, formatos de insumo). */
export function montarDados(
  registros: Registro[],
  rotulo: Rotulador,
  // Dimensão vinda da aba/tabela "Itens", quando presente: fonte da verdade
  // para propriedades, ordem e conjunto de itens (membros sem fato inclusos).
  dimensao?: ItemDim[],
): Dados {
  const erro = fazErro(rotulo);
  type Grupo = {
    meta: NonNullable<ReturnType<typeof scenarioMeta>>;
    versao: string;
    periodo: string;
    regs: Registro[];
  };
  const grupos = new Map<string, Grupo>();
  for (const reg of registros) {
    const meta = scenarioMeta(reg.versao, reg.periodo, reg.linha, erro)!;
    const g = grupos.get(meta.id) ?? { meta, versao: reg.versao, periodo: reg.periodo, regs: [] };
    g.regs.push(reg);
    grupos.set(meta.id, g);
  }

  const scenarios: InsertScenario[] = [];
  const params: InsertScenarioParams[] = [];
  const sales: InsertSalesFact[] = [];
  const fixed: InsertFixedCostFact[] = [];
  const inputs: InsertInputPriceFact[] = [];
  const misc: InsertMiscFact[] = [];

  for (const g of grupos.values()) {
    scenarios.push({
      id: g.meta.id,
      version: g.meta.versao,
      period: g.periodo,
      periodKind: g.meta.periodKind,
      label: g.meta.label,
      sortOrder: g.meta.sortOrder,
    });

    // Parametros — todos obrigatórios
    const par = new Map<string, number>();
    for (const r of g.regs) {
      if (r.secao !== "Parametros") continue;
      if (par.has(r.indicador)) {
        erro(r.linha, `parâmetro ${r.indicador} duplicado no cenário ${g.versao}/${g.periodo}`);
      }
      par.set(r.indicador, r.valor);
    }
    for (const ind of INDICADORES.Parametros) {
      if (!par.has(ind)) {
        throw new Error(
          `Cenário ${g.versao}/${g.periodo}: parâmetro obrigatório ausente: ${ind}`,
        );
      }
    }
    params.push({
      scenarioId: g.meta.id,
      fxRate: par.get("cambio_brl_usd")!,
      fcFxRate: par.get("cambio_custo_fixo_brl_usd")!,
      crudeSteelKt: par.get("aco_bruto_kt")!,
      ebitdaKusd: par.get("ebitda_kusd")!,
      dmCostShare: par.get("participacao_custo_interno")!,
    });

    // Vendas — agrega os 3 indicadores por item, ordem = primeira aparição
    type Venda = { reg: Registro; vals: Map<string, number>; ordem: number };
    const vendas = new Map<string, Venda>();
    const fixos = new Map<string, { reg: Registro; ordem: number }>();
    const insumos = new Map<string, { reg: Registro; vals: Map<string, number>; ordem: number }>();
    const ajustes: { reg: Registro; ordem: number }[] = [];
    for (const r of g.regs) {
      if (r.secao === "Vendas") {
        const v = vendas.get(r.item) ?? { reg: r, vals: new Map(), ordem: vendas.size };
        if (v.vals.has(r.indicador)) {
          erro(r.linha, `indicador ${r.indicador} duplicado para o produto "${r.item}"`);
        }
        if (r.moeda !== v.reg.moeda || r.atributo !== v.reg.atributo || r.grupo !== v.reg.grupo) {
          erro(
            r.linha,
            `produto "${r.item}" com moeda/atributo/grupo inconsistentes entre as linhas ` +
              `(${rotulo(v.reg.linha)}: ${v.reg.moeda}/${v.reg.atributo}/${v.reg.grupo ?? ""}; ` +
              `esta: ${r.moeda}/${r.atributo}/${r.grupo ?? ""})`,
          );
        }
        v.vals.set(r.indicador, r.valor);
        vendas.set(r.item, v);
      } else if (r.secao === "CustoFixo") {
        if (fixos.has(r.item)) erro(r.linha, `categoria de custo fixo duplicada: "${r.item}"`);
        fixos.set(r.item, { reg: r, ordem: fixos.size });
      } else if (r.secao === "Insumos") {
        const v = insumos.get(r.item) ?? { reg: r, vals: new Map(), ordem: insumos.size };
        if (v.vals.has(r.indicador)) {
          erro(r.linha, `indicador ${r.indicador} duplicado para o insumo "${r.item}"`);
        }
        if (r.grupo !== v.reg.grupo) {
          erro(
            r.linha,
            `insumo "${r.item}" com grupo inconsistente entre as linhas ` +
              `(${rotulo(v.reg.linha)}: "${v.reg.grupo ?? ""}"; esta: "${r.grupo ?? ""}")`,
          );
        }
        v.vals.set(r.indicador, r.valor);
        insumos.set(r.item, v);
      } else if (r.secao === "Ajustes") {
        const dup = ajustes.find(
          (a) => a.reg.item === r.item && a.reg.atributo === r.atributo,
        );
        if (dup) {
          erro(
            r.linha,
            `ajuste duplicado: "${r.item}" (${r.atributo}) já apareceu (${rotulo(dup.reg.linha)})`,
          );
        }
        ajustes.push({ reg: r, ordem: ajustes.length });
      }
    }

    for (const [item, v] of vendas) {
      for (const ind of INDICADORES.Vendas) {
        if (!v.vals.has(ind)) {
          erro(v.reg.linha, `produto "${item}" sem o indicador ${ind} no cenário ${g.versao}/${g.periodo}`);
        }
      }
      sales.push({
        scenarioId: g.meta.id,
        productKey: slug(item),
        label: item,
        groupLabel: v.reg.grupo,
        currency: v.reg.moeda!,
        domestic: v.reg.atributo === "interno",
        qtyKt: v.vals.get("quantidade_kt")!,
        amountKusd: v.vals.get("montante_kusd")!,
        varCostKusd: v.vals.get("custo_variavel_kusd")!,
        sortOrder: v.ordem,
      });
    }
    for (const [item, f] of fixos) {
      fixed.push({
        scenarioId: g.meta.id,
        category: item,
        groupLabel: f.reg.grupo,
        amountKusd: f.reg.valor,
        usdDenominated: f.reg.moeda === "USD",
        sortOrder: f.ordem,
      });
    }
    for (const [item, v] of insumos) {
      const precificado = v.vals.has("preco_usd_t");
      if (precificado && v.vals.has("montante_kusd")) {
        erro(v.reg.linha, `insumo "${item}" mistura preco_usd_t e montante_kusd — use um formato só`);
      }
      if (precificado && !v.vals.has("fator_rendimento")) {
        erro(v.reg.linha, `insumo precificado "${item}" sem fator_rendimento`);
      }
      if (!precificado && v.vals.has("fator_rendimento")) {
        erro(v.reg.linha, `insumo "${item}" tem fator_rendimento sem preco_usd_t — use um formato só`);
      }
      if (!precificado && !v.vals.has("montante_kusd")) {
        erro(v.reg.linha, `insumo "${item}" sem preco_usd_t nem montante_kusd`);
      }
      inputs.push({
        scenarioId: g.meta.id,
        item,
        groupLabel: v.reg.grupo,
        unitPriceUsd: precificado ? v.vals.get("preco_usd_t")! : null,
        yieldFactor: precificado ? v.vals.get("fator_rendimento")! : null,
        amountKusd: precificado ? null : v.vals.get("montante_kusd")!,
        sortOrder: v.ordem,
      });
    }
    for (const a of ajustes) {
      misc.push({
        scenarioId: g.meta.id,
        driver: ATRIBUTO_TO_DRIVER[a.reg.atributo!],
        label: a.reg.item,
        groupLabel: a.reg.grupo,
        amountKusd: a.reg.valor,
        sortOrder: a.ordem,
      });
    }
  }

  // ---------- consistência entre meses da mesma versão ----------
  // A fonte é mensal e o painel consolida FY/trimestre somando os meses.
  // A classificação de um item não pode mudar de um mês para outro — senão a
  // consolidação atribuiria câmbio/moeda/formato errados ao período inteiro.
  const versaoAno = (scenarioId: string) => scenarioId.replace(/_m\d{2}_/, "|");
  const conflito = (tipo: string, chave: string, o: string, n: string) => {
    throw new Error(
      `${tipo} "${chave}" com classificação inconsistente entre meses da mesma versão ` +
        `(${o} ≠ ${n}). A classificação deve ser igual em todos os meses.`,
    );
  };
  const vistoSales = new Map<string, string>();
  for (const s of sales) {
    const k = `${versaoAno(s.scenarioId)}|${s.productKey}`;
    const assinatura = `moeda=${s.currency}/atributo=${s.domestic ? "interno" : "externo"}/grupo=${s.groupLabel ?? ""}`;
    const prev = vistoSales.get(k);
    if (prev === undefined) vistoSales.set(k, assinatura);
    else if (prev !== assinatura) conflito("produto", s.label, prev, assinatura);
  }
  const vistoFixed = new Map<string, string>();
  for (const f of fixed) {
    const k = `${versaoAno(f.scenarioId)}|${f.category}`;
    const assinatura = `moeda=${f.usdDenominated ? "USD" : "BRL"}/grupo=${f.groupLabel ?? ""}`;
    const prev = vistoFixed.get(k);
    if (prev === undefined) vistoFixed.set(k, assinatura);
    else if (prev !== assinatura) conflito("categoria de custo fixo", f.category, prev, assinatura);
  }
  const vistoInputs = new Map<string, string>();
  for (const i of inputs) {
    const k = `${versaoAno(i.scenarioId)}|${i.item}`;
    const assinatura = `formato=${i.unitPriceUsd != null ? "preco_usd_t" : "montante_kusd"}/grupo=${i.groupLabel ?? ""}`;
    const prev = vistoInputs.get(k);
    if (prev === undefined) vistoInputs.set(k, assinatura);
    else if (prev !== assinatura) conflito("insumo", i.item, prev, assinatura);
  }

  const dimensional = montarDimensional(
    registros,
    (r) => scenarioMeta(r.versao, r.periodo, r.linha, erro)!.id,
    rotulo,
    dimensao,
  );
  return { scenarios, params, sales, fixed, inputs, misc, ...dimensional };
}

/**
 * Substitui todos os dados do painel dentro de uma única transação.
 * Grava o modelo dimensional (dim_items + indicator_facts), a fonte canônica
 * lida pelo painel. As tabelas largas legadas são apenas limpas — nenhum
 * dado novo é gravado nelas.
 */
export async function gravarDados(d: Dados): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(indicatorFactsTable);
    await tx.delete(dimItemsTable);
    await tx.delete(miscFactsTable);
    await tx.delete(inputPriceFactsTable);
    await tx.delete(fixedCostFactsTable);
    await tx.delete(salesFactsTable);
    await tx.delete(scenarioParamsTable);
    await tx.delete(scenariosTable);
    const chunk = <T,>(arr: T[], n: number) =>
      Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
    for (const c of chunk(d.scenarios, 500)) await tx.insert(scenariosTable).values(c);
    for (const c of chunk(d.dims, 500)) await tx.insert(dimItemsTable).values(c);
    for (const c of chunk(d.facts, 1000)) await tx.insert(indicatorFactsTable).values(c);
  });
}

export async function fecharConexao(): Promise<void> {
  await pool.end();
}

export function resumo(totalLinhas: number, d: Dados): string {
  return (
    `Validado: ${totalLinhas} linhas → ${d.scenarios.length} cenários | ` +
    `${d.sales.length} vendas | ${d.fixed.length} custo fixo | ` +
    `${d.inputs.length} insumos | ${d.misc.length} ajustes`
  );
}
