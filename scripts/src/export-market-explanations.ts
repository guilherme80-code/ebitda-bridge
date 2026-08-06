/**
 * Exporta as EXPLICAÇÕES (indicadores de mercado) do banco para o Excel no
 * formato por VERSÃO — o mesmo contrato aceito por import-market-explanations:
 *   - "Explicacoes": versao | periodo | explicacao | linha | valor | kt |
 *     tipo ("preco" ou "valor") | sentido (1 ou -1) | unidade
 *   - "Itens": explicacao | item
 *
 * Uma versão e um período (mensal) por linha; o par origem × destino é
 * escolhido no app e o cálculo é feito dinamicamente na seleção.
 *
 * Uso: pnpm --filter @workspace/scripts run export-market-explanations [caminho.xlsx]
 */
import path from "node:path";
import * as fs from "node:fs";
import * as XLSX from "xlsx";
import {
  db,
  pool,
  scenariosTable,
  marketIndicatorsTable,
  marketIndicatorLinesTable,
  marketIndicatorValuesTable,
  marketIndicatorItemsTable,
} from "@workspace/db";

const DEFAULT_OUT = path.resolve(
  import.meta.dirname,
  "../../exports/Explicacoes_Mercado_Bridge_EBITDA.xlsx",
);

async function main() {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT;

  const [indicators, lines, values, items, scenarios] = await Promise.all([
    db.select().from(marketIndicatorsTable),
    db.select().from(marketIndicatorLinesTable),
    db.select().from(marketIndicatorValuesTable),
    db.select().from(marketIndicatorItemsTable),
    db.select().from(scenariosTable),
  ]);
  indicators.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  lines.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  const scenario = new Map(scenarios.map((s) => [s.id, s]));
  const linesByIndicator = new Map<number, typeof lines>();
  for (const l of lines) {
    const arr = linesByIndicator.get(l.indicatorId) ?? [];
    arr.push(l);
    linesByIndicator.set(l.indicatorId, arr);
  }
  const valuesByLine = new Map<number, typeof values>();
  for (const v of values) {
    const arr = valuesByLine.get(v.lineId) ?? [];
    arr.push(v);
    valuesByLine.set(v.lineId, arr);
  }

  type LinhaExp = {
    versao: string;
    periodo: string;
    explicacao: string;
    linha: string;
    valor: number;
    kt: number | null;
    tipo: string;
    sentido: number;
    unidade: string;
  };
  const linhasExp: LinhaExp[] = [];
  const linhasItens: { explicacao: string; item: string }[] = [];

  for (const ind of indicators) {
    for (const line of linesByIndicator.get(ind.id) ?? []) {
      const vals = [...(valuesByLine.get(line.id) ?? [])].sort((a, b) =>
        a.scenarioId.localeCompare(b.scenarioId),
      );
      for (const v of vals) {
        const sc = scenario.get(v.scenarioId);
        if (!sc) throw new Error(`Cenário desconhecido nos valores: ${v.scenarioId}`);
        if (!/^fy\d{2}_m\d{2}_/.test(v.scenarioId)) {
          throw new Error(
            `Valor da linha "${line.label}" ("${ind.title}") aponta para cenário ` +
              `não mensal (${v.scenarioId}) — o contrato de importação aceita só meses`,
          );
        }
        if (v.value == null || !Number.isFinite(v.value)) {
          throw new Error(
            `Valor nulo/não numérico na linha "${line.label}" ("${ind.title}") no ` +
              `cenário ${v.scenarioId} — corrija o dado antes de exportar`,
          );
        }
        linhasExp.push({
          versao: sc.version,
          periodo: sc.period,
          explicacao: ind.title,
          linha: line.label,
          valor: v.value,
          kt: v.volumeKt,
          tipo: line.kind === "amount" ? "valor" : "preco",
          sentido: line.direction,
          unidade: ind.unitLabel,
        });
      }
    }
    for (const it of items.filter((i) => i.indicatorId === ind.id)) {
      linhasItens.push({ explicacao: ind.title, item: it.item });
    }
  }
  if (linhasExp.length === 0) {
    throw new Error("Nenhum valor de explicação no banco — nada a exportar.");
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(linhasExp, {
      header: ["versao", "periodo", "explicacao", "linha", "valor", "kt", "tipo", "sentido", "unidade"],
    }),
    "Explicacoes",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(linhasItens, { header: ["explicacao", "item"] }),
    "Itens",
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
  console.log(
    `Exportado: ${linhasExp.length} valores (versão × mês), ${linhasItens.length} itens → ${out}`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
