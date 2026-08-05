/**
 * Importa a fonte de dados do painel Bridge de EBITDA a partir de UMA ÚNICA
 * ABA ("Indicadores"), conforme docs/modelo-indicadores.md.
 *
 * Cada linha é um registro padronizado:
 *   versao | periodo | secao | item | indicador | valor | moeda | atributo
 *
 * A importação valida o formato (colunas, seções, indicadores e valores) e
 * interrompe com mensagem clara — apontando a linha — em vez de gravar dados
 * incompletos. Nada é gravado fora da transação.
 *
 * Uso: pnpm --filter @workspace/scripts run import-indicadores [caminho.xlsx]
 */
import path from "node:path";
import * as fs from "node:fs";
import * as XLSX from "xlsx";
import {
  db,
  pool,
  scenariosTable,
  scenarioParamsTable,
  salesFactsTable,
  fixedCostFactsTable,
  inputPriceFactsTable,
  miscFactsTable,
  type InsertScenario,
  type InsertScenarioParams,
  type InsertSalesFact,
  type InsertFixedCostFact,
  type InsertInputPriceFact,
  type InsertMiscFact,
} from "@workspace/db";

const DEFAULT_PATH = path.resolve(
  import.meta.dirname,
  "../../exports/Fonte_Indicadores_Bridge_EBITDA.xlsx",
);
const SHEET = "Indicadores";

const COLUNAS = ["versao", "periodo", "secao", "item", "indicador", "valor"] as const;
const VERSIONS = ["BUDGET", "MRF1", "MRF2", "MRF3", "MRF4", "MRF5", "MRF6", "MRF7"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

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

type Registro = {
  linha: number; // linha na planilha (1-based, contando o cabeçalho)
  versao: string;
  periodo: string;
  secao: string;
  item: string;
  indicador: string;
  valor: number;
  moeda: string | null;
  atributo: string | null;
};

function erro(linha: number, msg: string): never {
  throw new Error(`Linha ${linha}: ${msg}`);
}

/** Deriva id, tipo de período, rótulo e ordenação do cenário (mesma convenção
 *  do painel: fy26_fy_budget, fy26_q1_mrf3, fy26_m01_mrf7...). */
function scenarioMeta(versao: string, periodo: string, linha: number) {
  const vi = VERSIONS.indexOf(versao);
  if (vi < 0) erro(linha, `versao desconhecida: "${versao}" (esperado ${VERSIONS.join(", ")})`);
  const vSlug = versao.toLowerCase();
  const vLabel = versao === "BUDGET" ? "Budget" : versao;

  let m: RegExpMatchArray | null;
  if ((m = periodo.match(/^FY(\d{2})$/))) {
    const yy = m[1];
    return {
      id: `fy${yy}_fy_${vSlug}`,
      periodKind: "year",
      label: `FY${yy} ${vLabel}`,
      sortOrder: vi,
    };
  }
  if ((m = periodo.match(/^Q([1-4])(\d{2})$/))) {
    const q = Number(m[1]);
    return {
      id: `fy${m[2]}_q${q}_${vSlug}`,
      periodKind: "quarter",
      label: `${periodo} ${vLabel}`,
      sortOrder: 1000 + (vi + 1) * 10 + (q - 1),
    };
  }
  const mi = MONTHS.indexOf(periodo.slice(0, 3));
  if (mi >= 0 && /^\d{2}$/.test(periodo.slice(3))) {
    return {
      id: `fy${periodo.slice(3)}_m${String(mi + 1).padStart(2, "0")}_${vSlug}`,
      periodKind: "month",
      label: `${periodo} ${vLabel}`,
      sortOrder: 10000 + (vi + 1) * 100 + mi,
    };
  }
  erro(linha, `periodo desconhecido: "${periodo}" (esperado FY26, Q126..Q426 ou JAN26..DEC26)`);
}

async function main() {
  const filePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_PATH;
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Arquivo não encontrado: ${filePath}\n` +
        `Gere-o com: pnpm --filter @workspace/scripts run export-indicadores`,
    );
  }
  const wb = XLSX.read(fs.readFileSync(filePath));
  const ws = wb.Sheets[SHEET];
  if (!ws) {
    throw new Error(
      `Aba "${SHEET}" não encontrada em ${path.basename(filePath)} ` +
        `(abas presentes: ${wb.SheetNames.join(", ")})`,
    );
  }

  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
  if (raw.length === 0) throw new Error(`Aba "${SHEET}" está vazia`);
  const headers = Object.keys(raw[0]);
  const faltando = COLUNAS.filter((c) => !headers.includes(c));
  if (faltando.length > 0) {
    throw new Error(
      `Colunas obrigatórias ausentes na aba "${SHEET}": ${faltando.join(", ")} ` +
        `(colunas presentes: ${headers.join(", ")})`,
    );
  }

  // ---------- validação linha a linha ----------
  const registros: Registro[] = raw.map((r, i) => {
    const linha = i + 2; // +1 do cabeçalho, +1 para 1-based
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
    return {
      linha,
      versao: texto("versao"),
      periodo: texto("periodo"),
      secao,
      item: texto("item"),
      indicador,
      valor,
      moeda,
      atributo,
    };
  });

  // ---------- agrupamento por cenário ----------
  type Grupo = { meta: ReturnType<typeof scenarioMeta>; versao: string; periodo: string; regs: Registro[] };
  const grupos = new Map<string, Grupo>();
  for (const reg of registros) {
    const meta = scenarioMeta(reg.versao, reg.periodo, reg.linha);
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
      version: g.versao,
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
        if (r.moeda !== v.reg.moeda || r.atributo !== v.reg.atributo) {
          erro(
            r.linha,
            `produto "${r.item}" com moeda/atributo inconsistentes entre as linhas ` +
              `(linha ${v.reg.linha}: ${v.reg.moeda}/${v.reg.atributo}; esta linha: ${r.moeda}/${r.atributo})`,
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
        v.vals.set(r.indicador, r.valor);
        insumos.set(r.item, v);
      } else if (r.secao === "Ajustes") {
        const dup = ajustes.find(
          (a) => a.reg.item === r.item && a.reg.atributo === r.atributo,
        );
        if (dup) {
          erro(r.linha, `ajuste duplicado: "${r.item}" (${r.atributo}) já apareceu na linha ${dup.reg.linha}`);
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
        amountKusd: a.reg.valor,
        sortOrder: a.ordem,
      });
    }
  }

  console.log(
    `Validado: ${registros.length} linhas → ${scenarios.length} cenários | ` +
      `${sales.length} vendas | ${fixed.length} custo fixo | ${inputs.length} insumos | ${misc.length} ajustes`,
  );

  await db.transaction(async (tx) => {
    await tx.delete(miscFactsTable);
    await tx.delete(inputPriceFactsTable);
    await tx.delete(fixedCostFactsTable);
    await tx.delete(salesFactsTable);
    await tx.delete(scenarioParamsTable);
    await tx.delete(scenariosTable);
    const chunk = <T,>(arr: T[], n: number) =>
      Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
    for (const c of chunk(scenarios, 500)) await tx.insert(scenariosTable).values(c);
    for (const c of chunk(params, 500)) await tx.insert(scenarioParamsTable).values(c);
    for (const c of chunk(sales, 1000)) await tx.insert(salesFactsTable).values(c);
    for (const c of chunk(fixed, 1000)) await tx.insert(fixedCostFactsTable).values(c);
    for (const c of chunk(inputs, 1000)) await tx.insert(inputPriceFactsTable).values(c);
    for (const c of chunk(misc, 1000)) await tx.insert(miscFactsTable).values(c);
  });

  console.log(`Importado de ${path.basename(filePath)} (aba "${SHEET}")`);
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
