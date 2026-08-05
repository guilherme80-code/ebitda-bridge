/**
 * Importa os dados do bridge de EBITDA a partir da aba "Cálculo" do Excel
 * (attached_assets/Modelo_Bridge_*.xlsx) e grava no banco.
 *
 * Fonte da verdade: linhas 2-13 da aba Cálculo (resumo do bridge, em MUSD)
 * e linhas de produto 17-81 (impactos por produto, em kUSD).
 *
 * Cada drill-down inclui uma linha de "Demais itens e ajustes" para que a soma
 * das linhas bata exatamente com o valor do componente.
 */
import path from "node:path";
import * as fs from "node:fs";
import * as XLSX from "xlsx";
import {
  db,
  pool,
  scenariosTable,
  bridgesTable,
  bridgeComponentsTable,
  bridgeDetailLinesTable,
} from "@workspace/db";

const XLSX_PATH = path.resolve(
  import.meta.dirname,
  "../../attached_assets/Modelo_Bridge_1785933984868.xlsx",
);

function num(sheet: XLSX.WorkSheet, addr: string): number {
  const cell = sheet[addr] as { v?: unknown } | undefined;
  const v = cell?.v;
  return typeof v === "number" ? v : 0;
}

function str(sheet: XLSX.WorkSheet, addr: string): string | null {
  const cell = sheet[addr] as { v?: unknown } | undefined;
  const v = cell?.v;
  return typeof v === "string" ? v.trim() : null;
}

async function main() {
  const wb = XLSX.read(fs.readFileSync(XLSX_PATH));
  const calc = wb.Sheets["Cálculo"];
  if (!calc) throw new Error("Aba 'Cálculo' não encontrada no Excel");

  // ---- Resumo do bridge (MUSD), coluna C ----
  const start = num(calc, "C3"); // EBITDA FY26'B = 632.044
  const forex = num(calc, "C4"); // 70.573
  const sellingPrice = num(calc, "C5"); // 286.549
  const volume = num(calc, "C6"); // -23.126
  const mix = num(calc, "C7"); // 16.446
  const fixedCost = num(calc, "C8"); // -34.291
  const inputPrice = num(calc, "C9"); // -177.472
  const usage = num(calc, "C10"); // -12.829
  const others = num(calc, "C11"); // -5.764
  const stockVariation = num(calc, "C12"); // -4.437
  const end = num(calc, "C13"); // EBITDA FY26'F7 = 747.692

  const computedEnd =
    start +
    forex +
    sellingPrice +
    volume +
    mix +
    fixedCost +
    inputPrice +
    usage +
    others +
    stockVariation;
  if (Math.abs(computedEnd - end) > 0.01) {
    throw new Error(
      `Bridge não fecha: início ${start} + deltas = ${computedEnd}, esperado ${end}`,
    );
  }

  // ---- Componentes do waterfall (ordem da aba Bridge) ----
  const components = [
    { key: "ebitda_budget", label: "EBITDA FY26 Budget", kind: "total_start", valueMusd: start },
    { key: "vol_mix", label: "Volume & Mix", kind: "delta", valueMusd: volume + mix },
    { key: "selling_price", label: "Preço de venda", kind: "delta", valueMusd: sellingPrice },
    { key: "input_price", label: "Preço de insumos", kind: "delta", valueMusd: inputPrice },
    { key: "usage", label: "Consumo (Usage)", kind: "delta", valueMusd: usage },
    { key: "fixed_cost", label: "Custo fixo", kind: "delta", valueMusd: fixedCost },
    { key: "forex", label: "Câmbio", kind: "delta", valueMusd: forex },
    { key: "sv_others", label: "Estoque / Outros", kind: "delta", valueMusd: others + stockVariation },
    { key: "ebitda_mrf7", label: "EBITDA FY26 MRF7", kind: "total_end", valueMusd: end },
  ].map((c, i) => ({ ...c, sortOrder: i }));

  // ---- Linhas de produto (17-81): rótulo em B, impactos em kUSD ----
  // P = impacto de preço (kUSD), Q = câmbio (kUSD)
  // Linhas de contribuição (83+): K = Vol & Mix (kUSD) — deslocamento de 66 linhas
  type ProdLine = { label: string; price: number; forex: number; volMix: number };
  const prods: ProdLine[] = [];
  for (let r = 17; r <= 80; r++) {
    const label = str(calc, `B${r}`);
    if (!label || label.startsWith("Total")) continue;
    prods.push({
      label,
      price: num(calc, `P${r}`) / 1000,
      forex: num(calc, `Q${r}`) / 1000,
      volMix: num(calc, `K${r + 66}`) / 1000,
    });
  }

  const TOP = 10;
  function topWithRemainder(
    componentKey: string,
    total: number,
    pick: (p: ProdLine) => number,
    group: string | null,
  ) {
    const ranked = prods
      .map((p) => ({ label: p.label, value: pick(p) }))
      .filter((p) => Math.abs(p.value) > 0.005)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, TOP);
    const sum = ranked.reduce((s, p) => s + p.value, 0);
    const lines = ranked.map((p, i) => ({
      componentKey,
      label: p.label,
      group,
      valueMusd: p.value,
      sortOrder: i,
    }));
    const remainder = total - sum;
    if (Math.abs(remainder) > 0.005) {
      lines.push({
        componentKey,
        label: "Demais itens e ajustes",
        group,
        valueMusd: remainder,
        sortOrder: lines.length,
      });
    }
    return lines;
  }

  const detailLines = [
    // Vol & Mix: decomposição oficial Volume/Mix + produtos com maior contribuição
    { componentKey: "vol_mix", label: "Volume", group: "Resumo", valueMusd: volume, sortOrder: 0 },
    { componentKey: "vol_mix", label: "Mix", group: "Resumo", valueMusd: mix, sortOrder: 1 },
    ...topWithRemainder("vol_mix_products", volume + mix, (p) => p.volMix, null).map(
      (l, i) => ({ ...l, componentKey: "vol_mix", group: "Por produto", sortOrder: 2 + i }),
    ),
    // Preço de venda por produto
    ...topWithRemainder("selling_price", sellingPrice, (p) => p.price, "Por produto"),
    // Câmbio por produto
    ...topWithRemainder("forex", forex, (p) => p.forex, "Por produto"),
    // Estoque / Outros: decomposição oficial
    { componentKey: "sv_others", label: "Outros (Others)", group: null, valueMusd: others, sortOrder: 0 },
    { componentKey: "sv_others", label: "Variação de estoque", group: null, valueMusd: stockVariation, sortOrder: 1 },
    // Componentes sem abertura por produto na aba Cálculo: total único
    { componentKey: "input_price", label: "Total preço de insumos (aba Cálculo)", group: null, valueMusd: inputPrice, sortOrder: 0 },
    { componentKey: "usage", label: "Total consumo (aba Cálculo)", group: null, valueMusd: usage, sortOrder: 0 },
    { componentKey: "fixed_cost", label: "Total custo fixo (aba Cálculo)", group: null, valueMusd: fixedCost, sortOrder: 0 },
  ];

  // Valida que cada drill-down fecha com o componente
  for (const c of components.filter((c) => c.kind === "delta")) {
    const lines = detailLines.filter((l) => l.componentKey === c.key);
    if (lines.length === 0) continue;
    // Para vol_mix e sv_others, o grupo "Resumo"/null oficial já soma o total;
    // grupos "Por produto" são visão alternativa que também soma o total.
    const groups = [...new Set(lines.map((l) => l.group))];
    for (const g of groups) {
      const sum = lines
        .filter((l) => l.group === g)
        .reduce((s, l) => s + l.valueMusd, 0);
      if (Math.abs(sum - c.valueMusd) > 0.02) {
        throw new Error(
          `Drill-down de ${c.key} (grupo ${g}) soma ${sum.toFixed(3)}, esperado ${c.valueMusd.toFixed(3)}`,
        );
      }
    }
  }

  // ---- Cenários (versão + período) e o bridge desta importação ----
  const scenarios = [
    { id: "fy26_budget", version: "Budget", period: "FY26", label: "FY26 Budget", sortOrder: 0 },
    { id: "fy26_mrf7", version: "MRF7", period: "FY26", label: "FY26 MRF7", sortOrder: 1 },
  ];

  await db.transaction(async (tx) => {
    await tx.delete(bridgeDetailLinesTable);
    await tx.delete(bridgeComponentsTable);
    await tx.delete(bridgesTable);
    await tx.delete(scenariosTable);
    await tx.insert(scenariosTable).values(scenarios);
    const [bridge] = await tx
      .insert(bridgesTable)
      .values({
        sourceScenarioId: "fy26_budget",
        targetScenarioId: "fy26_mrf7",
        title: "Bridge de EBITDA — FY26 Budget vs FY26 MRF7",
        isDefault: true,
      })
      .returning();
    await tx
      .insert(bridgeComponentsTable)
      .values(components.map((c) => ({ ...c, bridgeId: bridge.id })));
    await tx
      .insert(bridgeDetailLinesTable)
      .values(detailLines.map((l) => ({ ...l, bridgeId: bridge.id })));
  });

  console.log(
    `Importado: ${components.length} componentes, ${detailLines.length} linhas de detalhe.`,
  );
  console.log(
    `Bridge: ${start.toFixed(1)} -> ${end.toFixed(1)} MUSD (variação ${(end - start).toFixed(1)})`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
