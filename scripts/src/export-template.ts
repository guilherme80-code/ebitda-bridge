/**
 * Gera um modelo Excel (template) com a estrutura da fonte de dados que
 * alimenta o painel Bridge de EBITDA — para ser reproduzida no Databricks.
 *
 * Abas:
 *  - Instruções: regras do modelo de dados
 *  - Cenarios: catálogo versão × período
 *  - Fatos: EBITDA e níveis por alavanca, por cenário
 *  - Detalhes: linhas de drill-down por alavanca (opcional)
 *  - Metricas: chaves válidas da coluna "metrica"/"alavanca"
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
  scenarioFactsTable,
  scenarioDetailFactsTable,
  BRIDGE_DRIVERS,
} from "@workspace/db";

const OUT = path.resolve(import.meta.dirname, "../../exports/Template_Fonte_Dados_Bridge_EBITDA.xlsx");

async function main() {
  const exampleIds = ["fy26_fy_budget", "fy26_fy_mrf7"];
  const scenarios = (await db.select().from(scenariosTable)).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const facts = (await db.select().from(scenarioFactsTable)).filter((f) =>
    exampleIds.includes(f.scenarioId),
  );
  const details = (await db.select().from(scenarioDetailFactsTable))
    .filter((d) => d.scenarioId === "fy26_fy_mrf7")
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const wb = XLSX.utils.book_new();

  // ---- Instruções ----
  const instrucoes = [
    ["MODELO DA FONTE DE DADOS — PAINEL BRIDGE DE EBITDA"],
    [],
    ["Preencha as abas Cenarios, Fatos e Detalhes (esta última é opcional, usada no drill-down)."],
    [],
    ["REGRAS DO MODELO:"],
    ["1. Cada cenário é uma combinação de VERSÃO (BUDGET, MRF1..MRF7) e PERÍODO (FY26, Q126..Q426, JAN26..DEC26)."],
    ["2. tipo_periodo deve ser: year (ano), quarter (trimestre) ou month (mês). Só se comparam períodos do mesmo tipo."],
    ["3. Na aba Fatos, cada cenário tem uma linha com metrica = ebitda (valor do EBITDA em MUSD)"],
    ["   e uma linha por alavanca com o NÍVEL ACUMULADO relativo à referência (BUDGET = 0)."],
    ["   Ex.: se o preço de venda do MRF7 está 286,5 MUSD acima do Budget, a linha selling_price do MRF7 vale 286,5."],
    ["4. Consistência obrigatória: ebitda do cenário = ebitda da referência + soma dos níveis das alavancas."],
    ["   Assim, o bridge de qualquer par origem→destino fecha exatamente (destino − origem por alavanca)."],
    ["5. Alavancas com nível zero podem ser omitidas."],
    ["6. Na aba Detalhes, as linhas de cada alavanca de um cenário devem somar o nível daquela alavanca."],
    ["   Linhas ausentes em um dos cenários são tratadas como zero na comparação."],
    ["7. Valores sempre em MUSD (milhões de dólares)."],
    [],
    ["As abas contêm exemplos reais de FY26 Budget (referência) e FY26 MRF7 (632,0 → 747,7 MUSD)."],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instrucoes), "Instruções");

  // ---- Cenarios ----
  const cenariosRows = scenarios.map((s) => ({
    cenario_id: s.id,
    versao: s.version,
    periodo: s.period,
    tipo_periodo: s.periodKind,
    rotulo: s.label,
    ordem: s.sortOrder,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cenariosRows), "Cenarios");

  // ---- Fatos (exemplo real) ----
  const factsRows = facts
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId))
    .map((f) => ({
      cenario_id: f.scenarioId,
      metrica: f.metric,
      valor_musd: f.valueMusd,
    }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(factsRows), "Fatos");

  // ---- Detalhes (exemplo real) ----
  const detailRows = details.map((d) => ({
    cenario_id: d.scenarioId,
    alavanca: d.componentKey,
    linha: d.label,
    grupo: d.group ?? "",
    valor_musd: d.valueMusd,
    ordem: d.sortOrder,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailRows), "Detalhes");

  // ---- Metricas (referência) ----
  const metricas = [
    { chave: "ebitda", descricao: "EBITDA do cenário (MUSD)" },
    ...BRIDGE_DRIVERS.map((d) => ({
      chave: d.key,
      descricao: `${d.label} — nível acumulado vs referência (MUSD)`,
    })),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(metricas), "Metricas");

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  XLSX.writeFile(wb, OUT);
  console.log(`Gerado: ${OUT}`);
  console.log(`Cenarios: ${cenariosRows.length} | Fatos exemplo: ${factsRows.length} | Detalhes exemplo: ${detailRows.length}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
