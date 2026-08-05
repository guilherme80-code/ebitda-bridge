/**
 * Exporta os dados atuais do banco para o formato de ABA ÚNICA
 * ("Indicadores"), conforme docs/modelo-indicadores.md.
 *
 * Cada linha é um registro padronizado:
 *   versao | periodo | secao | item | indicador | valor | moeda | atributo
 *
 * O arquivo gerado serve de referência (e de contrato para a futura tabela
 * no Databricks) e pode ser reimportado com import-indicadores.ts.
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
  "../../exports/Fonte_Indicadores_Bridge_EBITDA.xlsx",
);

type Linha = {
  versao: string;
  periodo: string;
  secao: string;
  item: string;
  indicador: string;
  valor: number;
  moeda?: string;
  atributo?: string;
};

const DRIVER_TO_ATRIBUTO: Record<string, string> = {
  usage: "consumo",
  others: "outros",
  stock_variation: "variacao_estoque",
};

async function main() {
  const scenarios = (await db.select().from(scenariosTable)).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const bySc = <T extends { scenarioId: string; sortOrder: number }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.scenarioId) ?? [];
      list.push(r);
      m.set(r.scenarioId, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
    return m;
  };
  const params = new Map(
    (await db.select().from(scenarioParamsTable)).map((p) => [p.scenarioId, p]),
  );
  const sales = bySc(await db.select().from(salesFactsTable));
  const fixed = bySc(await db.select().from(fixedCostFactsTable));
  const inputs = bySc(await db.select().from(inputPriceFactsTable));
  const misc = bySc(await db.select().from(miscFactsTable));

  const linhas: Linha[] = [];
  for (const sc of scenarios) {
    const base = { versao: sc.version, periodo: sc.period };
    const p = params.get(sc.id);
    if (!p) throw new Error(`Cenário sem parâmetros: ${sc.id}`);
    const par = (indicador: string, valor: number) =>
      linhas.push({ ...base, secao: "Parametros", item: "Global", indicador, valor });
    par("cambio_brl_usd", p.fxRate);
    par("cambio_custo_fixo_brl_usd", p.fcFxRate);
    par("aco_bruto_kt", p.crudeSteelKt);
    par("ebitda_kusd", p.ebitdaKusd);
    par("participacao_custo_interno", p.dmCostShare);

    for (const s of sales.get(sc.id) ?? []) {
      const meta = {
        ...base,
        secao: "Vendas",
        item: s.label,
        moeda: s.currency,
        atributo: s.domestic ? "interno" : "externo",
      };
      linhas.push({ ...meta, indicador: "quantidade_kt", valor: s.qtyKt });
      linhas.push({ ...meta, indicador: "montante_kusd", valor: s.amountKusd });
      linhas.push({ ...meta, indicador: "custo_variavel_kusd", valor: s.varCostKusd });
    }
    for (const f of fixed.get(sc.id) ?? []) {
      linhas.push({
        ...base,
        secao: "CustoFixo",
        item: f.category,
        indicador: "montante_kusd",
        valor: f.amountKusd,
        moeda: f.usdDenominated ? "USD" : "BRL",
      });
    }
    for (const i of inputs.get(sc.id) ?? []) {
      if (i.unitPriceUsd != null) {
        linhas.push({
          ...base,
          secao: "Insumos",
          item: i.item,
          indicador: "preco_usd_t",
          valor: i.unitPriceUsd,
        });
        linhas.push({
          ...base,
          secao: "Insumos",
          item: i.item,
          indicador: "fator_rendimento",
          valor: i.yieldFactor ?? 0,
        });
      } else {
        linhas.push({
          ...base,
          secao: "Insumos",
          item: i.item,
          indicador: "montante_kusd",
          valor: i.amountKusd ?? 0,
        });
      }
    }
    for (const m of misc.get(sc.id) ?? []) {
      linhas.push({
        ...base,
        secao: "Ajustes",
        item: m.label,
        indicador: "montante_kusd",
        valor: m.amountKusd,
        atributo: DRIVER_TO_ATRIBUTO[m.driver] ?? m.driver,
      });
    }
  }

  const ws = XLSX.utils.json_to_sheet(linhas, {
    header: ["versao", "periodo", "secao", "item", "indicador", "valor", "moeda", "atributo"],
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Indicadores");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  fs.writeFileSync(OUT, buf);
  console.log(`Exportado: ${linhas.length} linhas, ${scenarios.length} cenários → ${OUT}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
