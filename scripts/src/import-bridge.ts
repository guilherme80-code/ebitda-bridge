/**
 * Semeia o banco com DADOS BRUTOS (quantidade e montante) por versão/período,
 * conforme a estrutura da aba "Cálculo" do Modelo Bridge.xlsx.
 *
 * - FY26 BUDGET e FY26 MRF7 (ano cheio): dados reais extraídos do Excel
 *   (vendas por produto, custo variável, custo fixo, câmbio, insumos,
 *   consumo, others e variação de estoque).
 * - Meses/trimestres e versões MRF1..MRF6: dados fictícios determinísticos
 *   (interpolação entre Budget e MRF7 com ruído estável), com meses somando
 *   o trimestre e trimestres somando o ano.
 *
 * Nenhum efeito é pré-calculado — o painel calcula preço, volume, mix,
 * câmbio, custo fixo, insumos etc. na hora da comparação.
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

const XLSX_PATH = path.resolve(
  import.meta.dirname,
  "../../attached_assets/Modelo_Bridge_1785933984868.xlsx",
);

// ---------- utilidades ----------
type Sheet = XLSX.WorkSheet;
function num(sheet: Sheet, addr: string): number {
  const cell = sheet[addr] as { v?: unknown } | undefined;
  return typeof cell?.v === "number" ? cell.v : 0;
}
function numOr(sheet: Sheet, addr: string): number | null {
  const cell = sheet[addr] as { v?: unknown } | undefined;
  return typeof cell?.v === "number" ? cell.v : null;
}
function str(sheet: Sheet, addr: string): string | null {
  const cell = sheet[addr] as { v?: unknown } | undefined;
  return typeof cell?.v === "string" ? cell.v.trim() : null;
}
function hasFormula(sheet: Sheet, addr: string): boolean {
  const cell = sheet[addr] as { f?: string } | undefined;
  return !!cell?.f;
}
function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// RNG determinístico (mulberry32) — dados fictícios estáveis entre execuções.
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

/** Divide um total em 12 parcelas com sazonalidade, somando exatamente o total. */
function splitMonthly(total: number, weights: number[]): number[] {
  const wSum = weights.reduce((s, w) => s + w, 0);
  const parts = weights.map((w) => (total * w) / wSum);
  parts[11] += total - parts.reduce((s, p) => s + p, 0);
  return parts;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const VERSIONS = ["BUDGET", "MRF1", "MRF2", "MRF3", "MRF4", "MRF5", "MRF6", "MRF7"];
const YEAR = 26;

// linhas de receita expostas ao câmbio (soma de H150 na aba Cálculo)
const DOMESTIC_ROWS = new Set([
  20, 21, 23, 24, 25, 26, 27, 28, 30, 31, 32, 33, 35, 36, 37, 39, 40, 41, 42, 43, 45, 46, 47,
]);
// categorias de custo fixo sem separação cambial (denominadas em USD)
const USD_FIXED_ROWS = new Set([118, 120, 122, 124]);

async function main() {
  const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { cellFormula: true });
  const calc = wb.Sheets["Cálculo"];
  if (!calc) throw new Error("Aba 'Cálculo' não encontrada");

  // ---------- extração dos dados brutos reais (FY26 B e FY26 MRF7) ----------
  // Vendas (17-47) + custo variável (50-80, mesma ordem de produtos)
  type SalesRaw = {
    key: string;
    label: string;
    currency: "BRL" | "USD";
    domestic: boolean;
    sortOrder: number;
    b: { qty: number; amt: number; vc: number };
    t: { qty: number; amt: number; vc: number };
  };
  const salesRaw: SalesRaw[] = [];
  for (let r = 17; r <= 47; r++) {
    const vr = r + 33; // linha de custo variável correspondente (50-80)
    const label = str(calc, `B${r}`) ?? str(calc, `B${vr}`) ?? `Produto ${r}`;
    // custo variável unitário: coluna D do bloco 50-80 (USD/t) — definido
    // mesmo quando a quantidade é zero (produtos novos). A aba usa o mesmo
    // custo unitário para os dois cenários.
    const unitVc = num(calc, `D${vr}`) / 1000; // kUSD/kt... (USD/t ÷ 1000)
    const qtyB0 = num(calc, `C${r}`);
    const qtyT0 = num(calc, `F${r}`);
    const row: SalesRaw = {
      key: slug(label),
      label,
      currency: hasFormula(calc, `L${r}`) ? "BRL" : "USD",
      domestic: DOMESTIC_ROWS.has(r),
      sortOrder: r - 17,
      b: { qty: qtyB0, amt: num(calc, `E${r}`), vc: qtyB0 * unitVc },
      t: { qty: qtyT0, amt: num(calc, `H${r}`), vc: qtyT0 * unitVc },
    };
    if (row.b.qty === 0 && row.t.qty === 0 && row.b.amt === 0 && row.t.amt === 0) continue;
    salesRaw.push(row);
  }

  // Custo fixo (116-124)
  type FixedRaw = { category: string; usd: boolean; sortOrder: number; b: number; t: number };
  const fixedRaw: FixedRaw[] = [];
  for (let r = 116; r <= 124; r++) {
    const category = str(calc, `B${r}`);
    if (!category) continue;
    fixedRaw.push({
      category,
      usd: USD_FIXED_ROWS.has(r),
      sortOrder: r - 116,
      b: num(calc, `E${r}`),
      t: num(calc, `H${r}`),
    });
  }

  // Câmbio e produção de aço bruto
  const fxB = num(calc, "E152");
  const fxT = num(calc, "H152");
  // câmbio próprio do bloco de custo fixo (E125/H125)
  const fcFxB = num(calc, "E125");
  const fcFxT = num(calc, "H125");
  const crudeSteelKt = num(calc, "G144") * 1000; // G144 já está /1000

  // Insumos precificados (128-134) e diretos (135-143)
  type InputRaw = {
    item: string;
    sortOrder: number;
    priceB?: number;
    priceT?: number;
    yieldF?: number;
    levelB?: number;
    levelT?: number;
  };
  const inputRaw: InputRaw[] = [];
  for (let r = 128; r <= 134; r++) {
    const item = str(calc, `B${r}`);
    if (!item) continue;
    inputRaw.push({
      item,
      sortOrder: r - 128,
      priceB: num(calc, `D${r}`),
      priceT: num(calc, `G${r}`),
      yieldF: num(calc, `I${r}`),
    });
  }
  for (let r = 135; r <= 143; r++) {
    const item = str(calc, `B${r}`);
    if (!item) continue;
    const delta = r === 137 ? num(calc, "G137") - num(calc, "D137") : (numOr(calc, `J${r}`) ?? 0);
    inputRaw.push({ item, sortOrder: r - 128, levelB: 0, levelT: delta });
  }

  // Consumo (147) e Others/Estoque (155-181)
  type MiscRaw = { driver: string; label: string; sortOrder: number; b: number; t: number };
  const miscRaw: MiscRaw[] = [
    { driver: "usage", label: "Consumo de insumos", sortOrder: 0, b: 0, t: numOr(calc, "J147") ?? 0 },
  ];
  for (let r = 155; r <= 181; r++) {
    const label = str(calc, `B${r}`);
    const tag = str(calc, `J${r}`);
    if (!label || !tag) continue;
    const driver = tag === "Others" ? "others" : "stock_variation";
    const b = numOr(calc, `E${r}`) ?? 0;
    const t = numOr(calc, `H${r}`) ?? b + (numOr(calc, `I${r}`) ?? 0);
    if (b === 0 && t === 0) continue;
    miscRaw.push({ driver, label, sortOrder: r - 155, b, t });
  }

  // EBITDA real (kUSD)
  const ebitdaB = num(calc, "C3") * 1000;
  const ebitdaT = num(calc, "C13") * 1000;

  console.log(
    `Extraído do Excel: ${salesRaw.length} produtos, ${fixedRaw.length} categorias de custo fixo, ` +
      `${inputRaw.length} insumos, ${miscRaw.length} linhas misc | fx ${fxB.toFixed(2)}→${fxT.toFixed(2)} | ` +
      `EBITDA ${(ebitdaB / 1000).toFixed(1)}→${(ebitdaT / 1000).toFixed(1)} MUSD`,
  );

  // offset entre EBITDA contábil e (receita − custo var − custo fixo) — usado
  // para atribuir EBITDA plausível aos cenários fictícios.
  const marginOf = (side: "b" | "t") =>
    salesRaw.reduce((s, r) => s + r[side].amt - r[side].vc, 0) -
    fixedRaw.reduce((s, r) => s + r[side === "b" ? "b" : "t"], 0);
  const offsetB = ebitdaB - marginOf("b");
  const offsetT = ebitdaT - marginOf("t");

  // ---------- geração: por versão, 12 meses de dados brutos ----------
  // t(version): interpolação Budget(0) → MRF7(1) com ruído por produto/mês.
  const versionT = (vi: number) => vi / (VERSIONS.length - 1);

  interface MonthRaw {
    sales: Map<string, { qty: number; amt: number; vc: number }>;
    fixed: Map<string, number>;
    inputsPrice: Map<string, number>; // preço USD do mês
    inputsLevel: Map<string, number>;
    misc: Map<string, number>; // `${driver}|${label}`
    fx: number;
    fcFx: number;
    crudeKt: number;
    ebitda: number;
  }

  const monthData = new Map<string, MonthRaw[]>(); // por versão

  for (const [vi, version] of VERSIONS.entries()) {
    const t = versionT(vi);
    const isB = version === "BUDGET";
    const isT = version === "MRF7";
    const months: MonthRaw[] = MONTHS.map(() => ({
      sales: new Map(),
      fixed: new Map(),
      inputsPrice: new Map(),
      inputsLevel: new Map(),
      misc: new Map(),
      fx: 0,
      fcFx: 0,
      crudeKt: 0,
      ebitda: 0,
    }));

    // interpolação anual (exata nos extremos, ruído no meio)
    const lerp = (b: number, tt: number) =>
      isB ? b : isT ? tt : b + (tt - b) * t * between(0.7, 1.3);

    // vendas
    for (const row of salesRaw) {
      const qtyY = lerp(row.b.qty, row.t.qty);
      const amtY = lerp(row.b.amt, row.t.amt);
      const vcY = lerp(row.b.vc, row.t.vc);
      const w = MONTHS.map(() => between(0.7, 1.3));
      const qtyM = splitMonthly(qtyY, w);
      const amtM = splitMonthly(amtY, w); // mesmos pesos → preço estável no ano
      const vcM = splitMonthly(vcY, w);
      months.forEach((m, i) =>
        m.sales.set(row.key, { qty: qtyM[i], amt: amtM[i], vc: vcM[i] }),
      );
    }
    // custo fixo
    for (const row of fixedRaw) {
      const y = lerp(row.b, row.t);
      const parts = splitMonthly(y, MONTHS.map(() => between(0.85, 1.15)));
      months.forEach((m, i) => m.fixed.set(row.category, parts[i]));
    }
    // insumos
    for (const row of inputRaw) {
      if (row.priceB != null && row.priceT != null) {
        const pY = lerp(row.priceB, row.priceT);
        months.forEach((m) =>
          m.inputsPrice.set(row.item, pY * (isB || isT ? 1 : between(0.98, 1.02))),
        );
      } else {
        const y = lerp(row.levelB ?? 0, row.levelT ?? 0);
        const parts = splitMonthly(y, MONTHS.map(() => between(0.8, 1.2)));
        months.forEach((m, i) => m.inputsLevel.set(row.item, parts[i]));
      }
    }
    // misc
    for (const row of miscRaw) {
      const y = lerp(row.b, row.t);
      const parts = splitMonthly(y, MONTHS.map(() => between(0.8, 1.2)));
      months.forEach((m, i) => m.misc.set(`${row.driver}|${row.label}`, parts[i]));
    }
    // fx, produção, ebitda
    const fxY = lerp(fxB, fxT);
    const fcFxY = lerp(fcFxB, fcFxT);
    const crudeY = crudeSteelKt * (isB || isT ? 1 : between(0.95, 1.05));
    const crudeParts = splitMonthly(crudeY, MONTHS.map(() => between(0.9, 1.1)));
    const offsetY = lerp(offsetB, offsetT);
    const offsetParts = splitMonthly(offsetY, MONTHS.map(() => between(0.9, 1.1)));
    months.forEach((m, i) => {
      const fxJitter = isB || isT ? 1 : 1 + between(-0.01, 0.01);
      m.fx = fxY * fxJitter;
      m.fcFx = fcFxY * fxJitter;
      m.crudeKt = crudeParts[i];
      const revenue = [...m.sales.values()].reduce((s, r) => s + r.amt, 0);
      const vc = [...m.sales.values()].reduce((s, r) => s + r.vc, 0);
      const fc = [...m.fixed.values()].reduce((s, r) => s + r, 0);
      m.ebitda = revenue - vc - fc + offsetParts[i];
    });

    // calibração: para BUDGET e MRF7 o ano deve bater exatamente com o real.
    if (isB || isT) {
      const target = isB ? ebitdaB : ebitdaT;
      const sum = months.reduce((s, m) => s + m.ebitda, 0);
      const adj = (target - sum) / 12;
      months.forEach((m) => (m.ebitda += adj));
    }
    monthData.set(version, months);
  }

  // ---------- materialização dos cenários (ano, trimestres, meses) ----------
  const scenarios: InsertScenario[] = [];
  const params: InsertScenarioParams[] = [];
  const sales: InsertSalesFact[] = [];
  const fixed: InsertFixedCostFact[] = [];
  const inputs: InsertInputPriceFact[] = [];
  const misc: InsertMiscFact[] = [];

  function aggregate(version: string, idxs: number[]): MonthRaw {
    const months = monthData.get(version)!;
    const sel = idxs.map((i) => months[i]);
    const agg: MonthRaw = {
      sales: new Map(),
      fixed: new Map(),
      inputsPrice: new Map(),
      inputsLevel: new Map(),
      misc: new Map(),
      fx: sel.reduce((s, m) => s + m.fx, 0) / sel.length,
      fcFx: sel.reduce((s, m) => s + m.fcFx, 0) / sel.length,
      crudeKt: sel.reduce((s, m) => s + m.crudeKt, 0),
      ebitda: sel.reduce((s, m) => s + m.ebitda, 0),
    };
    for (const m of sel) {
      for (const [k, v] of m.sales) {
        const cur = agg.sales.get(k) ?? { qty: 0, amt: 0, vc: 0 };
        agg.sales.set(k, { qty: cur.qty + v.qty, amt: cur.amt + v.amt, vc: cur.vc + v.vc });
      }
      for (const [k, v] of m.fixed) agg.fixed.set(k, (agg.fixed.get(k) ?? 0) + v);
      for (const [k, v] of m.inputsLevel) agg.inputsLevel.set(k, (agg.inputsLevel.get(k) ?? 0) + v);
      for (const [k, v] of m.misc) agg.misc.set(k, (agg.misc.get(k) ?? 0) + v);
      for (const [k, v] of m.inputsPrice) {
        // preço médio ponderado pela produção
        agg.inputsPrice.set(k, (agg.inputsPrice.get(k) ?? 0) + v * m.crudeKt);
      }
    }
    for (const [k, v] of agg.inputsPrice) agg.inputsPrice.set(k, v / agg.crudeKt);
    return agg;
  }

  function addScenario(opts: {
    id: string;
    version: string;
    period: string;
    periodKind: string;
    label: string;
    sortOrder: number;
    data: MonthRaw;
  }) {
    const { id, data } = opts;
    scenarios.push({
      id,
      version: opts.version,
      period: opts.period,
      periodKind: opts.periodKind,
      label: opts.label,
      sortOrder: opts.sortOrder,
    });
    params.push({
      scenarioId: id,
      fxRate: data.fx,
      fcFxRate: data.fcFx,
      crudeSteelKt: data.crudeKt,
      ebitdaKusd: data.ebitda,
      dmCostShare: 0.4,
    });
    for (const row of salesRaw) {
      const v = data.sales.get(row.key);
      if (!v) continue;
      sales.push({
        scenarioId: id,
        productKey: row.key,
        label: row.label,
        currency: row.currency,
        domestic: row.domestic,
        qtyKt: v.qty,
        amountKusd: v.amt,
        varCostKusd: v.vc,
        sortOrder: row.sortOrder,
      });
    }
    for (const row of fixedRaw) {
      fixed.push({
        scenarioId: id,
        category: row.category,
        amountKusd: data.fixed.get(row.category) ?? 0,
        usdDenominated: row.usd,
        sortOrder: row.sortOrder,
      });
    }
    for (const row of inputRaw) {
      if (row.priceB != null) {
        inputs.push({
          scenarioId: id,
          item: row.item,
          unitPriceUsd: data.inputsPrice.get(row.item) ?? row.priceB,
          yieldFactor: row.yieldF ?? 0,
          amountKusd: null,
          sortOrder: row.sortOrder,
        });
      } else {
        inputs.push({
          scenarioId: id,
          item: row.item,
          unitPriceUsd: null,
          yieldFactor: null,
          amountKusd: data.inputsLevel.get(row.item) ?? 0,
          sortOrder: row.sortOrder,
        });
      }
    }
    for (const row of miscRaw) {
      misc.push({
        scenarioId: id,
        driver: row.driver,
        label: row.label,
        amountKusd: data.misc.get(`${row.driver}|${row.label}`) ?? 0,
        sortOrder: row.sortOrder,
      });
    }
  }

  let sort = 0;
  for (const version of VERSIONS) {
    const vSlug = version.toLowerCase();
    const vLabel = version === "BUDGET" ? "Budget" : version;
    const all12 = MONTHS.map((_, i) => i);
    addScenario({
      id: `fy${YEAR}_fy_${vSlug}`,
      version,
      period: `FY${YEAR}`,
      periodKind: "year",
      label: `FY${YEAR} ${vLabel}`,
      sortOrder: sort++,
      data: aggregate(version, all12),
    });
    for (let q = 0; q < 4; q++) {
      addScenario({
        id: `fy${YEAR}_q${q + 1}_${vSlug}`,
        version,
        period: `Q${q + 1}${YEAR}`,
        periodKind: "quarter",
        label: `Q${q + 1}${YEAR} ${vLabel}`,
        sortOrder: 1000 + sort * 10 + q,
        data: aggregate(version, [q * 3, q * 3 + 1, q * 3 + 2]),
      });
    }
    for (let m = 0; m < 12; m++) {
      addScenario({
        id: `fy${YEAR}_m${String(m + 1).padStart(2, "0")}_${vSlug}`,
        version,
        period: `${MONTHS[m]}${YEAR}`,
        periodKind: "month",
        label: `${MONTHS[m]}${YEAR} ${vLabel}`,
        sortOrder: 10000 + sort * 100 + m,
        data: aggregate(version, [m]),
      });
    }
  }

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

  console.log(
    `Importado: ${scenarios.length} cenários | ${sales.length} linhas de vendas | ` +
      `${fixed.length} custo fixo | ${inputs.length} insumos | ${misc.length} misc`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
