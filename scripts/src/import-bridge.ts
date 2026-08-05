/**
 * Semeia o banco com cenários por versão e período.
 *
 * - FY26 (ano cheio): BUDGET e MRF7 vêm dos dados reais da aba "Cálculo" do
 *   Excel (attached_assets/Modelo_Bridge_*.xlsx) — 632,0 → 747,7 MUSD.
 * - Todas as demais combinações (FY25/FY26/FY27 × BUDGET/MRF1..MRF7 ×
 *   ano/trimestre/mês) recebem dados de exemplo gerados de forma
 *   determinística (mesma semente → mesmos números a cada execução).
 *
 * Modelo: por cenário guardamos o nível de EBITDA e, por driver/linha de
 * detalhe, o nível acumulado relativo à referência comum (BUDGET FY26 = 0).
 * O bridge de qualquer par origem→destino do MESMO tipo de período
 * (ano×ano, trimestre×trimestre, mês×mês) é calculado na hora como
 * destino − origem.
 *
 * Consistência garantida: meses somam o trimestre, trimestres somam o ano,
 * e o EBITDA de cada cenário = base do período + soma dos níveis de driver —
 * logo qualquer bridge fecha exatamente.
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
  type InsertScenario,
  type InsertScenarioFact,
  type InsertScenarioDetailFact,
} from "@workspace/db";

const XLSX_PATH = path.resolve(
  import.meta.dirname,
  "../../attached_assets/Modelo_Bridge_1785933984868.xlsx",
);

// ---------- utilidades ----------
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

// RNG determinístico (mulberry32) para dados de exemplo estáveis entre execuções.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260805);
const between = (lo: number, hi: number) => lo + (hi - lo) * rnd();

const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const YEARS = [2025, 2026, 2027];
const VERSIONS = ["BUDGET", "MRF1", "MRF2", "MRF3", "MRF4", "MRF5", "MRF6", "MRF7"];

async function main() {
  // ---------- dados reais FY26 (Excel) ----------
  const wb = XLSX.read(fs.readFileSync(XLSX_PATH));
  const calc = wb.Sheets["Cálculo"];
  if (!calc) throw new Error("Aba 'Cálculo' não encontrada no Excel");

  const start = num(calc, "C3"); // EBITDA FY26'B = 632.044
  const forex = num(calc, "C4");
  const sellingPrice = num(calc, "C5");
  const volume = num(calc, "C6");
  const mix = num(calc, "C7");
  const fixedCost = num(calc, "C8");
  const inputPrice = num(calc, "C9");
  const usage = num(calc, "C10");
  const others = num(calc, "C11");
  const stockVariation = num(calc, "C12");
  const end = num(calc, "C13"); // EBITDA FY26'F7 = 747.692

  const realDeltas: Record<string, number> = {
    vol_mix: volume + mix,
    selling_price: sellingPrice,
    input_price: inputPrice,
    usage: usage,
    fixed_cost: fixedCost,
    forex: forex,
    sv_others: others + stockVariation,
  };
  const computedEnd =
    start + Object.values(realDeltas).reduce((s, v) => s + v, 0);
  if (Math.abs(computedEnd - end) > 0.01) {
    throw new Error(
      `Bridge não fecha: início ${start} + deltas = ${computedEnd}, esperado ${end}`,
    );
  }

  // ---------- linhas de produto reais (drill-down FY26 BUDGET→MRF7) ----------
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
  const realDetailLines = [
    { componentKey: "vol_mix", label: "Volume", group: "Resumo", valueMusd: volume, sortOrder: 0 },
    { componentKey: "vol_mix", label: "Mix", group: "Resumo", valueMusd: mix, sortOrder: 1 },
    ...topWithRemainder("vol_mix_products", volume + mix, (p) => p.volMix, null).map(
      (l, i) => ({ ...l, componentKey: "vol_mix", group: "Por produto", sortOrder: 2 + i }),
    ),
    ...topWithRemainder("selling_price", sellingPrice, (p) => p.price, "Por produto"),
    ...topWithRemainder("forex", forex, (p) => p.forex, "Por produto"),
    { componentKey: "sv_others", label: "Outros (Others)", group: null, valueMusd: others, sortOrder: 0 },
    { componentKey: "sv_others", label: "Variação de estoque", group: null, valueMusd: stockVariation, sortOrder: 1 },
    { componentKey: "input_price", label: "Total preço de insumos (aba Cálculo)", group: null, valueMusd: inputPrice, sortOrder: 0 },
    { componentKey: "usage", label: "Total consumo (aba Cálculo)", group: null, valueMusd: usage, sortOrder: 0 },
    { componentKey: "fixed_cost", label: "Total custo fixo (aba Cálculo)", group: null, valueMusd: fixedCost, sortOrder: 0 },
  ];

  // ---------- geração dos níveis mensais por (ano, versão, driver) ----------
  // BUDGET FY26 é a referência (níveis 0). MRF7 FY26 reproduz exatamente os
  // deltas reais. Demais combinações: exemplo determinístico com magnitude
  // proporcional aos deltas reais.
  const BASE_M = start / 12; // base mensal de EBITDA da referência

  // splitMonthly: divide um total anual em 12 parcelas com variação sazonal,
  // somando exatamente o total.
  function splitMonthly(total: number): number[] {
    const weights = MONTHS.map(() => between(0.6, 1.4));
    const wSum = weights.reduce((s, w) => s + w, 0);
    const parts = weights.map((w) => (total * w) / wSum);
    // corrige resíduo numérico no último mês
    const diff = total - parts.reduce((s, p) => s + p, 0);
    parts[11] += diff;
    return parts;
  }

  // monthlyLevels[year][version][driverKey] = número[12]
  const monthlyLevels = new Map<string, number[]>();
  const levelKey = (y: number, v: string, d: string) => `${y}|${v}|${d}`;
  for (const year of YEARS) {
    for (const version of VERSIONS) {
      for (const d of BRIDGE_DRIVERS) {
        let annual: number;
        if (year === 2026 && version === "BUDGET") {
          annual = 0;
        } else if (year === 2026 && version === "MRF7") {
          annual = realDeltas[d.key];
        } else {
          // exemplo: fração do delta real com sinal preservado e ruído
          const scale = between(-0.4, 1.3);
          annual = realDeltas[d.key] * scale;
        }
        monthlyLevels.set(levelKey(year, version, d.key), splitMonthly(annual));
      }
    }
  }

  // ---------- montagem dos cenários, fatos e detalhes ----------
  const scenarios: InsertScenario[] = [];
  const facts: InsertScenarioFact[] = [];
  const detailFacts: InsertScenarioDetailFact[] = [];

  // pesos fixos por driver para o drill-down de exemplo (somam 1)
  const DEMO_PRODUCTS = [
    "Vergalhão", "Fio-máquina", "Barras", "Perfis", "Arames", "Demais produtos",
  ];
  const demoWeights = [0.3, 0.22, 0.18, 0.13, 0.1, 0.07];

  function addScenario(opts: {
    id: string;
    version: string;
    period: string;
    periodKind: string;
    label: string;
    sortOrder: number;
    levels: Record<string, number>; // driver -> nível
    ebitdaBase: number; // base do período (BASE_M * nº de meses)
    realDetail?: boolean; // usa linhas reais do Excel (FY26 MRF7 ano)
  }) {
    scenarios.push({
      id: opts.id,
      version: opts.version,
      period: opts.period,
      periodKind: opts.periodKind,
      label: opts.label,
      sortOrder: opts.sortOrder,
    });
    const levelSum = Object.values(opts.levels).reduce((s, v) => s + v, 0);
    facts.push({
      scenarioId: opts.id,
      metric: "ebitda",
      valueMusd: opts.ebitdaBase + levelSum,
    });
    for (const d of BRIDGE_DRIVERS) {
      const level = opts.levels[d.key] ?? 0;
      if (Math.abs(level) < 1e-9) continue;
      facts.push({ scenarioId: opts.id, metric: d.key, valueMusd: level });
      if (opts.realDetail) continue; // detalhes reais adicionados à parte
      DEMO_PRODUCTS.forEach((label, i) => {
        detailFacts.push({
          scenarioId: opts.id,
          componentKey: d.key,
          label,
          group: "Por produto",
          valueMusd: level * demoWeights[i],
          sortOrder: i,
        });
      });
    }
    if (opts.realDetail) {
      for (const l of realDetailLines) {
        detailFacts.push({ ...l, scenarioId: opts.id });
      }
    }
  }

  let sort = 0;
  for (const year of YEARS) {
    const fy = `FY${year % 100}`;
    for (const [vi, version] of VERSIONS.entries()) {
      const months = BRIDGE_DRIVERS.reduce<Record<string, number[]>>((acc, d) => {
        acc[d.key] = monthlyLevels.get(levelKey(year, version, d.key))!;
        return acc;
      }, {});
      const sumRange = (d: string, from: number, to: number) =>
        months[d].slice(from, to).reduce((s, v) => s + v, 0);
      const idBase = `fy${year % 100}`;
      const vSlug = version.toLowerCase();

      // Ano
      addScenario({
        id: `${idBase}_fy_${vSlug}`,
        version,
        period: fy,
        periodKind: "year",
        label: `${fy} ${version === "BUDGET" ? "Budget" : version}`,
        sortOrder: sort++,
        levels: Object.fromEntries(
          BRIDGE_DRIVERS.map((d) => [d.key, sumRange(d.key, 0, 12)]),
        ),
        ebitdaBase: BASE_M * 12,
        realDetail: year === 2026 && version === "MRF7",
      });
      // Trimestres
      for (let q = 0; q < 4; q++) {
        addScenario({
          id: `${idBase}_q${q + 1}_${vSlug}`,
          version,
          period: `${fy} Q${q + 1}`,
          periodKind: "quarter",
          label: `${fy} Q${q + 1} ${version === "BUDGET" ? "Budget" : version}`,
          sortOrder: 1000 + sort * 10 + q,
          levels: Object.fromEntries(
            BRIDGE_DRIVERS.map((d) => [d.key, sumRange(d.key, q * 3, q * 3 + 3)]),
          ),
          ebitdaBase: BASE_M * 3,
        });
      }
      // Meses
      for (let m = 0; m < 12; m++) {
        addScenario({
          id: `${idBase}_m${String(m + 1).padStart(2, "0")}_${vSlug}`,
          version,
          period: `${fy} ${MONTHS[m]}`,
          periodKind: "month",
          label: `${fy} ${MONTHS[m]} ${version === "BUDGET" ? "Budget" : version}`,
          sortOrder: 10000 + sort * 100 + m,
          levels: Object.fromEntries(
            BRIDGE_DRIVERS.map((d) => [d.key, months[d.key][m]]),
          ),
          ebitdaBase: BASE_M,
        });
      }
      void vi;
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(scenarioDetailFactsTable);
    await tx.delete(scenarioFactsTable);
    await tx.delete(scenariosTable);
    // inserts em lote para não estourar limites de parâmetros
    const chunk = <T,>(arr: T[], n: number) =>
      Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
        arr.slice(i * n, i * n + n),
      );
    for (const c of chunk(scenarios, 500)) await tx.insert(scenariosTable).values(c);
    for (const c of chunk(facts, 1000)) await tx.insert(scenarioFactsTable).values(c);
    for (const c of chunk(detailFacts, 1000))
      await tx.insert(scenarioDetailFactsTable).values(c);
  });

  console.log(
    `Importado: ${scenarios.length} cenários, ${facts.length} fatos, ${detailFacts.length} linhas de detalhe.`,
  );
  console.log(
    `Referência real FY26 Budget→MRF7: ${start.toFixed(1)} -> ${end.toFixed(1)} MUSD (variação ${(end - start).toFixed(1)})`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
