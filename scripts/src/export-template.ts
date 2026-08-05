/**
 * Gera um modelo Excel (template) com a estrutura da fonte de DADOS BRUTOS que
 * alimenta o painel Bridge de EBITDA — para ser reproduzida no Databricks.
 *
 * O painel calcula todos os efeitos (preço, volume, mix, câmbio, custo fixo,
 * insumos, consumo, estoque) na hora da comparação, seguindo as fórmulas da
 * aba "Cálculo" da planilha original. A fonte só precisa trazer dados brutos.
 *
 * Abas:
 *  - Instruções: regras do modelo de dados
 *  - Cenarios: catálogo versão × período
 *  - Parametros: câmbio, produção de aço bruto, EBITDA por cenário
 *  - Vendas: quantidade, faturamento e custo variável por produto
 *  - CustoFixo: montante por categoria
 *  - Insumos: preço unitário/rendimento ou montante direto por item
 *  - Misc: consumo (usage), outros e variação de estoque
 *
 * Preenchido com exemplos reais: FY26 Budget (referência) e FY26 MRF7.
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
} from "@workspace/db";

const OUT = path.resolve(
  import.meta.dirname,
  "../../exports/Template_Fonte_Dados_Bridge_EBITDA.xlsx",
);

const EXAMPLE_IDS = ["fy26_fy_budget", "fy26_fy_mrf7"];

async function main() {
  const inExample = (r: { scenarioId: string }) =>
    EXAMPLE_IDS.includes(r.scenarioId);
  const scenarios = (await db.select().from(scenariosTable)).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const params = (await db.select().from(scenarioParamsTable)).filter(inExample);
  const sales = (await db.select().from(salesFactsTable))
    .filter(inExample)
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.sortOrder - b.sortOrder);
  const fixed = (await db.select().from(fixedCostFactsTable))
    .filter(inExample)
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.sortOrder - b.sortOrder);
  const inputs = (await db.select().from(inputPriceFactsTable))
    .filter(inExample)
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.sortOrder - b.sortOrder);
  const misc = (await db.select().from(miscFactsTable))
    .filter(inExample)
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.sortOrder - b.sortOrder);

  const wb = XLSX.utils.book_new();

  // ---- Instruções ----
  const instrucoes = [
    ["MODELO DA FONTE DE DADOS (DADOS BRUTOS) — PAINEL BRIDGE DE EBITDA"],
    [],
    ["O painel calcula todos os efeitos do bridge na hora da comparação, seguindo as fórmulas da aba 'Cálculo'."],
    ["A fonte de dados só precisa trazer os dados brutos abaixo, por cenário (versão × período)."],
    [],
    ["REGRAS DO MODELO:"],
    ["1. Cada cenário é uma combinação de VERSÃO (BUDGET, MRF1..MRF7) e PERÍODO (FY26, Q126..Q426, JAN26..DEC26)."],
    ["2. tipo_periodo deve ser: year (ano), quarter (trimestre) ou month (mês). Só se comparam períodos do mesmo tipo."],
    ["3. Aba Parametros — uma linha por cenário:"],
    ["   cambio: BRL/USD médio do período | cambio_custo_fixo: câmbio usado no bloco de custo fixo (pode diferir levemente)"],
    ["   aco_bruto_kt: produção de aço bruto (kt) | ebitda_kusd: EBITDA do cenário em kUSD | participacao_custo_dm: fração do custo em moeda local (padrão 0,4)."],
    ["4. Aba Vendas — uma linha por produto por cenário:"],
    ["   qtd_t: quantidade (t) | faturamento_kusd: receita (kUSD) | custo_variavel_kusd: custo variável (kUSD)"],
    ["   moeda: BRL (preço formado em real) ou USD | mercado_interno: TRUE para vendas domésticas (expostas a câmbio)."],
    ["   Produtos novos (qtd zero na referência) são tratados automaticamente: efeito só em volume/mix e câmbio."],
    ["5. Aba CustoFixo — montante (kUSD) por categoria; usd: TRUE quando a categoria é denominada em USD (sem efeito câmbio)."],
    ["6. Aba Insumos — itens com preço: preco_usd (USD/unidade) e rendimento (consumo por t de aço); o efeito usa a produção de aço bruto."],
    ["   Itens sem preço: informar montante_kusd direto (o efeito é a diferença entre cenários)."],
    ["7. Aba Misc — alavanca = usage (consumo), others (outros, ex.: Logística/VAT) ou stock_variation (itens de variação de estoque)."],
    ["   A variação de estoque recebe também o ajuste de fechamento: o bridge sempre fecha exatamente no EBITDA informado."],
    ["8. Unidades: montantes em kUSD (milhares de USD); o painel apresenta em MUSD."],
    [],
    ["As abas contêm exemplos reais de FY26 Budget (referência) e FY26 MRF7 (632,0 → 747,7 MUSD)."],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instrucoes), "Instruções");

  // ---- Cenarios ----
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      scenarios.map((s) => ({
        cenario_id: s.id,
        versao: s.version,
        periodo: s.period,
        tipo_periodo: s.periodKind,
        rotulo: s.label,
        ordem: s.sortOrder,
      })),
    ),
    "Cenarios",
  );

  // ---- Parametros ----
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      params.map((p) => ({
        cenario_id: p.scenarioId,
        cambio: p.fxRate,
        cambio_custo_fixo: p.fcFxRate,
        aco_bruto_kt: p.crudeSteelKt,
        ebitda_kusd: p.ebitdaKusd,
        participacao_custo_dm: p.dmCostShare,
      })),
    ),
    "Parametros",
  );

  // ---- Vendas ----
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      sales.map((r) => ({
        cenario_id: r.scenarioId,
        produto: r.productKey,
        rotulo: r.label,
        moeda: r.currency,
        mercado_interno: r.domestic,
        qtd_t: r.qtyKt,
        faturamento_kusd: r.amountKusd,
        custo_variavel_kusd: r.varCostKusd,
        ordem: r.sortOrder,
      })),
    ),
    "Vendas",
  );

  // ---- CustoFixo ----
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      fixed.map((r) => ({
        cenario_id: r.scenarioId,
        categoria: r.category,
        montante_kusd: r.amountKusd,
        usd: r.usdDenominated,
        ordem: r.sortOrder,
      })),
    ),
    "CustoFixo",
  );

  // ---- Insumos ----
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      inputs.map((r) => ({
        cenario_id: r.scenarioId,
        item: r.item,
        preco_usd: r.unitPriceUsd ?? "",
        rendimento: r.yieldFactor ?? "",
        montante_kusd: r.amountKusd ?? "",
        ordem: r.sortOrder,
      })),
    ),
    "Insumos",
  );

  // ---- Misc ----
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      misc.map((r) => ({
        cenario_id: r.scenarioId,
        alavanca: r.driver,
        linha: r.label,
        montante_kusd: r.amountKusd,
        ordem: r.sortOrder,
      })),
    ),
    "Misc",
  );

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  XLSX.writeFile(wb, OUT);
  console.log(`Gerado: ${OUT}`);
  console.log(
    `Cenarios: ${scenarios.length} | Vendas exemplo: ${sales.length} | CustoFixo: ${fixed.length} | Insumos: ${inputs.length} | Misc: ${misc.length}`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
