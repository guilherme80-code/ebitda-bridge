/**
 * Exporta os dados atuais do banco no formato dimensional (modelo SAC):
 *   - aba "Itens": dimensão de itens com propriedades
 *       item | secao | moeda | atributo | grupo
 *     (ordem das linhas = ordem de exibição no painel)
 *   - aba "Indicadores": fato enxuta
 *       versao | periodo | item | indicador | valor
 *
 * O arquivo gerado serve de referência (e de contrato para as tabelas no
 * Databricks/SAC) e pode ser reimportado com import-indicadores.ts.
 */
import path from "node:path";
import * as fs from "node:fs";
import * as XLSX from "xlsx";
import { db, pool, scenariosTable, dimItemsTable, indicatorFactsTable } from "@workspace/db";

const OUT = path.resolve(
  import.meta.dirname,
  "../../exports/Fonte_Indicadores_Bridge_EBITDA.xlsx",
);

async function main() {
  const [scenarios, dims, facts] = await Promise.all([
    db.select().from(scenariosTable),
    db.select().from(dimItemsTable),
    db.select().from(indicatorFactsTable),
  ]);
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  const dimByItem = new Map(dims.map((d) => [d.item, d]));
  const scOrder = new Map(scenarios.map((s) => [s.id, s.sortOrder]));

  const abaItens = [...dims]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d, i) => ({
      item: d.item,
      secao: d.secao,
      ...(d.moeda ? { moeda: d.moeda } : {}),
      ...(d.atributo ? { atributo: d.atributo } : {}),
      ...(d.grupo ? { grupo: d.grupo } : {}),
      // Ordinal explícito: em tabelas SQL (Databricks) a ordem de retorno não
      // é determinística — esta coluna fixa a ordem de exibição.
      sort_order: i,
    }));

  const abaFato = [...facts]
    .sort((a, b) => {
      const so = (scOrder.get(a.scenarioId) ?? 0) - (scOrder.get(b.scenarioId) ?? 0);
      if (so !== 0) return so;
      const io =
        (dimByItem.get(a.item)?.sortOrder ?? 0) - (dimByItem.get(b.item)?.sortOrder ?? 0);
      if (io !== 0) return io;
      return a.indicador.localeCompare(b.indicador);
    })
    .map((f) => {
      const sc = scenarioById.get(f.scenarioId);
      if (!sc) throw new Error(`Fato referencia cenário inexistente: ${f.scenarioId}`);
      if (!dimByItem.has(f.item)) {
        throw new Error(`Fato referencia item fora da dimensão: "${f.item}"`);
      }
      if (!Number.isFinite(f.valor)) {
        throw new Error(`Valor não numérico na fato (${f.scenarioId}/${f.item}/${f.indicador})`);
      }
      return {
        versao: sc.version,
        periodo: sc.period,
        item: f.item,
        indicador: f.indicador,
        valor: f.valor,
      };
    });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(abaItens, {
      header: ["item", "secao", "moeda", "atributo", "grupo", "sort_order"],
    }),
    "Itens",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(abaFato, {
      header: ["versao", "periodo", "item", "indicador", "valor"],
    }),
    "Indicadores",
  );
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  fs.writeFileSync(OUT, buf);
  console.log(
    `Exportado: ${abaItens.length} itens (aba "Itens"), ${abaFato.length} linhas de fato ` +
      `(aba "Indicadores"), ${scenarios.length} cenários → ${OUT}`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
