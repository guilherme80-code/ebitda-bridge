import { describe, it, expect } from "vitest";
import { aggregateMonths, deriveScenarios } from "./aggregate";
import type { RawScenarioData } from "./bridge-calc";
import type { Scenario } from "@workspace/db";

/** Fixture mensal mínima e controlada para validar as ponderações. */
function month(
  id: string,
  opts: {
    fx: number;
    fcFx?: number;
    crude: number;
    ebitda: number;
    dmShare: number;
    sales?: RawScenarioData["sales"];
    fixed?: RawScenarioData["fixed"];
    inputs?: RawScenarioData["inputs"];
    misc?: RawScenarioData["misc"];
  },
): RawScenarioData {
  return {
    params: {
      scenarioId: id,
      fxRate: opts.fx,
      fcFxRate: opts.fcFx ?? opts.fx,
      crudeSteelKt: opts.crude,
      ebitdaKusd: opts.ebitda,
      dmCostShare: opts.dmShare,
    },
    sales: opts.sales ?? [],
    fixed: opts.fixed ?? [],
    inputs: opts.inputs ?? [],
    misc: opts.misc ?? [],
  };
}

const sale = (
  scenarioId: string,
  amountKusd: number,
  domestic = true,
  over: Partial<RawScenarioData["sales"][number]> = {},
): RawScenarioData["sales"][number] => ({
  id: 1,
  scenarioId,
  productKey: over.productKey ?? "p1",
  label: over.label ?? "Produto 1",
  groupLabel: null,
  currency: over.currency ?? (domestic ? "BRL" : "USD"),
  domestic,
  qtyKt: over.qtyKt ?? 10,
  amountKusd,
  varCostKusd: over.varCostKusd ?? -amountKusd / 2,
  sortOrder: 1,
  ...over,
});

describe("aggregateMonths — ponderações", () => {
  it("soma grandezas aditivas e pondera o câmbio pela receita doméstica", () => {
    const m1 = month("m1", {
      fx: 5.0,
      crude: 100,
      ebitda: 1000,
      dmShare: 0.8,
      sales: [sale("m1", 300, true)],
    });
    const m2 = month("m2", {
      fx: 6.0,
      crude: 200,
      ebitda: 2000,
      dmShare: 0.6,
      sales: [sale("m2", 100, true)],
    });
    const agg = aggregateMonths("fy", [m1, m2]);
    expect(agg.params.ebitdaKusd).toBe(3000);
    expect(agg.params.crudeSteelKt).toBe(300);
    // fx ponderado por receita doméstica: (5*300 + 6*100) / 400 = 5.25
    expect(agg.params.fxRate).toBeCloseTo(5.25, 12);
    expect(agg.sales).toHaveLength(1);
    expect(agg.sales[0].qtyKt).toBe(20);
    expect(agg.sales[0].amountKusd).toBe(400);
  });

  it("pondera o câmbio do custo fixo pelos custos fixos em BRL", () => {
    const fixedRow = (
      scenarioId: string,
      amountKusd: number,
      usdDenominated: boolean,
    ): RawScenarioData["fixed"][number] => ({
      id: 1,
      scenarioId,
      category: usdDenominated ? "USD cat" : "BRL cat",
      groupLabel: null,
      amountKusd,
      usdDenominated,
      sortOrder: 1,
    });
    const m1 = month("m1", {
      fx: 5,
      fcFx: 5.0,
      crude: 1,
      ebitda: 0,
      dmShare: 0.5,
      fixed: [fixedRow("m1", -90, false), fixedRow("m1", -999, true)],
    });
    const m2 = month("m2", {
      fx: 5,
      fcFx: 6.0,
      crude: 1,
      ebitda: 0,
      dmShare: 0.5,
      fixed: [fixedRow("m2", -10, false), fixedRow("m2", -1, true)],
    });
    const agg = aggregateMonths("fy", [m1, m2]);
    // ponderado só pelo BRL: (5*90 + 6*10) / 100 = 5.1 (linhas USD não pesam)
    expect(agg.params.fcFxRate).toBeCloseTo(5.1, 12);
    expect(agg.fixed.find((f) => !f.usdDenominated)?.amountKusd).toBe(-100);
  });

  it("pondera preço de insumo pelo consumo (rendimento × aço bruto) e soma montantes diretos", () => {
    const priced = (
      scenarioId: string,
      unitPriceUsd: number,
      yieldFactor: number,
    ): RawScenarioData["inputs"][number] => ({
      id: 1,
      scenarioId,
      item: "Coal",
      groupLabel: null,
      unitPriceUsd,
      yieldFactor,
      amountKusd: null,
      sortOrder: 1,
    });
    const direct = (
      scenarioId: string,
      amountKusd: number,
    ): RawScenarioData["inputs"][number] => ({
      id: 2,
      scenarioId,
      item: "Direto",
      groupLabel: null,
      unitPriceUsd: null,
      yieldFactor: null,
      amountKusd,
      sortOrder: 2,
    });
    const m1 = month("m1", {
      fx: 5,
      crude: 100,
      ebitda: 0,
      dmShare: 0.5,
      inputs: [priced("m1", 200, 0.5), direct("m1", -30)],
    });
    const m2 = month("m2", {
      fx: 5,
      crude: 300,
      ebitda: 0,
      dmShare: 0.5,
      inputs: [priced("m2", 100, 0.5), direct("m2", -70)],
    });
    const agg = aggregateMonths("fy", [m1, m2]);
    const coal = agg.inputs.find((i) => i.item === "Coal")!;
    // consumo m1 = 0.5*100 = 50; m2 = 0.5*300 = 150 → preço = (200*50+100*150)/200 = 125
    expect(coal.unitPriceUsd).toBeCloseTo(125, 12);
    expect(coal.yieldFactor).toBeCloseTo(0.5, 12);
    expect(agg.inputs.find((i) => i.item === "Direto")?.amountKusd).toBe(-100);
  });

  it("rejeita produto que muda de mercado/moeda entre meses", () => {
    const m1 = month("m1", { fx: 5, crude: 1, ebitda: 0, dmShare: 0.5, sales: [sale("m1", 100, true)] });
    const m2 = month("m2", { fx: 5, crude: 1, ebitda: 0, dmShare: 0.5, sales: [sale("m2", 100, false)] });
    expect(() => aggregateMonths("fy", [m1, m2])).toThrow(/inconsistente/);
  });

  it("rejeita insumo que mistura preço e montante direto entre meses", () => {
    const m1 = month("m1", {
      fx: 5, crude: 1, ebitda: 0, dmShare: 0.5,
      inputs: [{ id: 1, scenarioId: "m1", item: "Coal", groupLabel: null, unitPriceUsd: 100, yieldFactor: 0.5, amountKusd: null, sortOrder: 1 }],
    });
    const m2 = month("m2", {
      fx: 5, crude: 1, ebitda: 0, dmShare: 0.5,
      inputs: [{ id: 1, scenarioId: "m2", item: "Coal", groupLabel: null, unitPriceUsd: null, yieldFactor: null, amountKusd: -50, sortOrder: 1 }],
    });
    expect(() => aggregateMonths("fy", [m1, m2])).toThrow(/inconsistente/);
  });

  it("rejeita categoria de custo fixo que muda a flag USD entre meses", () => {
    const row = (scenarioId: string, usd: boolean): RawScenarioData["fixed"][number] => ({
      id: 1, scenarioId, category: "Cat", groupLabel: null, amountKusd: -10, usdDenominated: usd, sortOrder: 1,
    });
    const m1 = month("m1", { fx: 5, crude: 1, ebitda: 0, dmShare: 0.5, fixed: [row("m1", false)] });
    const m2 = month("m2", { fx: 5, crude: 1, ebitda: 0, dmShare: 0.5, fixed: [row("m2", true)] });
    expect(() => aggregateMonths("fy", [m1, m2])).toThrow(/inconsistente/);
  });
});

describe("deriveScenarios", () => {
  const mk = (mm: number, vi: number, vSlug: string, vLabel: string): Scenario => ({
    id: `fy26_m${String(mm).padStart(2, "0")}_${vSlug}`,
    version: vSlug.toUpperCase(),
    period: `M${mm}26`,
    periodKind: "month",
    label: `M${mm}26 ${vLabel}`,
    sortOrder: 10000 + (vi + 1) * 100 + (mm - 1),
  });

  it("deriva FY e trimestres apenas quando todos os meses existem", () => {
    const months = Array.from({ length: 12 }, (_, i) => mk(i + 1, 1, "budget", "Budget"));
    const derived = deriveScenarios(months);
    expect(derived.map((d) => d.id)).toEqual([
      "fy26_fy_budget",
      "fy26_q1_budget",
      "fy26_q2_budget",
      "fy26_q3_budget",
      "fy26_q4_budget",
    ]);
    expect(derived[0].sortOrder).toBe(1); // vi reconstruído da ordenação mensal
    expect(derived[0].monthIds).toHaveLength(12);

    // Faltando dezembro: sem FY nem Q4, mas Q1..Q3 continuam
    const partial = deriveScenarios(months.slice(0, 11));
    expect(partial.map((d) => d.id)).toEqual([
      "fy26_q1_budget",
      "fy26_q2_budget",
      "fy26_q3_budget",
    ]);
  });
});
