/**
 * Semeia a tabela de fatos `fato_bridge_detalhe` a partir da aba "Cálculo"
 * do Excel (attached_assets/Modelo_Bridge_*.xlsx).
 *
 * Modelo: valores ABSOLUTOS por cenário (versao × periodo), grão
 * versao × periodo × unidade × driver × item × tipo_registro.
 * O bridge é calculado on-the-fly pela API: driver = destino − origem.
 *
 * FY26: os DELTAS entre BUDGET e MRF7 são fiéis ao Excel (linhas 2-13 do
 * resumo + aberturas por produto). Os níveis absolutos do BUDGET são
 * ilustrativos (alocação proporcional), de modo que MRF7 = BUDGET + delta.
 * Q1/Q2: cenários ilustrativos (escala do FY26 com variações determinísticas).
 */
import path from "node:path";
import * as fs from "node:fs";
import * as XLSX from "xlsx";
import {
  db,
  pool,
  scenariosTable,
  fatoBridgeDetalheTable,
  type InsertFatoBridgeDetalhe,
} from "@workspace/db";

const XLSX_PATH = path.resolve(
  import.meta.dirname,
  "../../attached_assets/Modelo_Bridge_1785933984868.xlsx",
);

const FONTE_EXCEL = "Excel aba Cálculo";
const FONTE_ILUSTRATIVA = "Ilustrativo (seed)";
const UNIDADE = "Consolidado";

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

type Fact = InsertFatoBridgeDetalhe;

async function main() {
  const wb = XLSX.read(fs.readFileSync(XLSX_PATH));
  const calc = wb.Sheets["Cálculo"];
  if (!calc) throw new Error("Aba 'Cálculo' não encontrada no Excel");

  // ---- Resumo do bridge FY26 Budget → MRF7 (MUSD), coluna C ----
  const start = num(calc, "C3"); // EBITDA FY26'B
  const forex = num(calc, "C4");
  const sellingPrice = num(calc, "C5");
  const volume = num(calc, "C6");
  const mix = num(calc, "C7");
  const fixedCost = num(calc, "C8");
  const inputPrice = num(calc, "C9");
  const usage = num(calc, "C10");
  const others = num(calc, "C11");
  const stockVariation = num(calc, "C12");
  const end = num(calc, "C13"); // EBITDA FY26'F7

  const computedEnd =
    start + forex + sellingPrice + volume + mix + fixedCost +
    inputPrice + usage + others + stockVariation;
  if (Math.abs(computedEnd - end) > 0.01) {
    throw new Error(
      `Bridge não fecha: início ${start} + deltas = ${computedEnd}, esperado ${end}`,
    );
  }

  // ---- Linhas de produto (17-81): rótulo em B, impactos em kUSD ----
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
  /** Top-N itens por |delta| + linha residual, garantindo soma = total. */
  function itemDeltas(
    total: number,
    pick: (p: ProdLine) => number,
  ): { item: string; delta: number }[] {
    const ranked = prods
      .map((p) => ({ item: p.label, delta: pick(p) }))
      .filter((p) => Math.abs(p.delta) > 0.005)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, TOP);
    const sum = ranked.reduce((s, p) => s + p.delta, 0);
    const remainder = total - sum;
    if (Math.abs(remainder) > 0.005) {
      ranked.push({ item: "Demais itens", delta: remainder });
    }
    return ranked;
  }

  // ---- Deltas FY26 por driver × item (fiéis ao Excel) ----
  const driverDeltas: Record<string, { item: string; delta: number }[]> = {
    vol_mix: itemDeltas(volume + mix, (p) => p.volMix),
    selling_price: itemDeltas(sellingPrice, (p) => p.price),
    forex: itemDeltas(forex, (p) => p.forex),
    input_price: [{ item: "Total preço de insumos", delta: inputPrice }],
    usage: [{ item: "Total consumo", delta: usage }],
    fixed_cost: [{ item: "Total custo fixo", delta: fixedCost }],
    sv_others: [
      { item: "Outros (Others)", delta: others },
      { item: "Variação de estoque", delta: stockVariation },
    ],
  };

  // ---- Níveis absolutos ilustrativos do BUDGET FY26 por driver ----
  // Devem somar exatamente o EBITDA de partida (start).
  const budgetDriverTotals: Record<string, number> = {
    vol_mix: 0,
    selling_price: 3120,
    input_price: -1680,
    usage: -260,
    fixed_cost: -540,
    forex: -20,
    sv_others: start - (3120 - 1680 - 260 - 540 - 20), // residual fecha o total
  };
  const totalCheck = Object.values(budgetDriverTotals).reduce((s, v) => s + v, 0);
  if (Math.abs(totalCheck - start) > 0.001) {
    throw new Error(`Baseline BUDGET não fecha: ${totalCheck} vs ${start}`);
  }

  /** Distribui o total do driver entre os itens, proporcional a |delta|. */
  function budgetItems(driver: string): { item: string; value: number }[] {
    const deltas = driverDeltas[driver];
    const total = budgetDriverTotals[driver];
    const weightSum = deltas.reduce((s, d) => s + Math.abs(d.delta) + 1, 0);
    let allocated = 0;
    return deltas.map((d, i) => {
      if (i === deltas.length - 1) {
        return { item: d.item, value: total - allocated };
      }
      const v = (total * (Math.abs(d.delta) + 1)) / weightSum;
      allocated += v;
      return { item: d.item, value: v };
    });
  }

  // ---- Monta os fatos FY26 ----
  const facts: Fact[] = [];

  // Ajuste gerencial no MRF7 FY26, carve-out do delta de "Outros (Others)"
  // (mantém a soma do driver idêntica ao Excel).
  const AJUSTE_FY26 = -2.0;

  for (const driver of Object.keys(driverDeltas)) {
    const base = budgetItems(driver);
    const deltas = new Map(driverDeltas[driver].map((d) => [d.item, d.delta]));
    for (const b of base) {
      const delta = deltas.get(b.item) ?? 0;
      facts.push({
        versao: "BUDGET",
        periodo: "FY26",
        unidade: UNIDADE,
        driver,
        item: b.item,
        tipoRegistro: "padrao",
        valorMusd: b.value,
        fonte: FONTE_ILUSTRATIVA,
      });
      const isAdjusted = driver === "sv_others" && b.item === "Outros (Others)";
      facts.push({
        versao: "MRF7",
        periodo: "FY26",
        unidade: UNIDADE,
        driver,
        item: b.item,
        tipoRegistro: "padrao",
        valorMusd: b.value + delta - (isAdjusted ? AJUSTE_FY26 : 0),
        fonte: FONTE_EXCEL,
      });
    }
  }
  facts.push({
    versao: "MRF7",
    periodo: "FY26",
    unidade: UNIDADE,
    driver: "sv_others",
    item: "Provisão de contingências",
    tipoRegistro: "ajuste",
    valorMusd: AJUSTE_FY26,
    justificativa:
      "Provisão adicional de contingências trabalhistas reconhecida no MRF7",
    responsavel: "Controladoria",
    status: "aprovado",
    fonte: "Ajuste manual",
  });

  // ---- Q1 / Q2 ilustrativos: escala determinística do FY26 ----
  // Fator base por período + variação por driver (hash simples do nome).
  function scaleFactor(periodo: string, versao: string, driver: string): number {
    const base = periodo === "Q1" ? 0.24 : 0.26;
    let h = 0;
    for (const ch of `${periodo}|${versao}|${driver}`) {
      h = (h * 31 + ch.charCodeAt(0)) % 997;
    }
    return base * (1 + ((h / 997) - 0.5) * 0.12); // ±6%
  }

  const fy26Facts = facts.filter((f) => f.tipoRegistro === "padrao");
  for (const periodo of ["Q1", "Q2"] as const) {
    for (const f of fy26Facts) {
      facts.push({
        ...f,
        periodo,
        valorMusd: f.valorMusd * scaleFactor(periodo, f.versao, f.driver),
        fonte: FONTE_ILUSTRATIVA,
      });
    }
  }
  // Ajuste gerencial ilustrativo no MRF7 Q1
  facts.push({
    versao: "MRF7",
    periodo: "Q1",
    unidade: UNIDADE,
    driver: "fixed_cost",
    item: "Reclassificação de despesas corporativas",
    tipoRegistro: "ajuste",
    valorMusd: 1.5,
    justificativa:
      "Reclassificação de rateio corporativo do Q1 aprovada em comitê",
    responsavel: "FP&A Corporativo",
    status: "pendente",
    fonte: "Ajuste manual",
  });

  // ---- Cenários (versão × período) ----
  const scenarios = [
    { id: "fy26_budget", version: "BUDGET", period: "FY26", label: "FY26 Budget", sortOrder: 0 },
    { id: "fy26_mrf7", version: "MRF7", period: "FY26", label: "FY26 MRF7", sortOrder: 1 },
    { id: "q1_budget", version: "BUDGET", period: "Q1", label: "Q1 Budget", sortOrder: 2 },
    { id: "q1_mrf7", version: "MRF7", period: "Q1", label: "Q1 MRF7", sortOrder: 3 },
    { id: "q2_budget", version: "BUDGET", period: "Q2", label: "Q2 Budget", sortOrder: 4 },
    { id: "q2_mrf7", version: "MRF7", period: "Q2", label: "Q2 MRF7", sortOrder: 5 },
  ];

  // ---- Validações antes de gravar ----
  const sum = (vs: Fact[]) => vs.reduce((s, f) => s + f.valorMusd, 0);
  const budgetTotal = sum(facts.filter((f) => f.versao === "BUDGET" && f.periodo === "FY26"));
  const mrf7Total = sum(facts.filter((f) => f.versao === "MRF7" && f.periodo === "FY26"));
  if (Math.abs(budgetTotal - start) > 0.01 || Math.abs(mrf7Total - end) > 0.01) {
    throw new Error(
      `Totais FY26 não fecham: BUDGET ${budgetTotal} (esp. ${start}), MRF7 ${mrf7Total} (esp. ${end})`,
    );
  }

  await db.transaction(async (tx) => {
    await tx.delete(fatoBridgeDetalheTable);
    await tx.delete(scenariosTable);
    await tx.insert(scenariosTable).values(scenarios);
    // Insere em lotes para não estourar limite de parâmetros
    for (let i = 0; i < facts.length; i += 500) {
      await tx.insert(fatoBridgeDetalheTable).values(facts.slice(i, i + 500));
    }
  });

  console.log(`Importado: ${facts.length} fatos, ${scenarios.length} cenários.`);
  console.log(
    `FY26: BUDGET ${budgetTotal.toFixed(1)} -> MRF7 ${mrf7Total.toFixed(1)} MUSD (variação ${(mrf7Total - budgetTotal).toFixed(1)})`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
