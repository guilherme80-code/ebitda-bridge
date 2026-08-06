import { describe, it, expect } from "vitest";
import {
  monthIdsOf,
  monthLabelOf,
  monthPairsOf,
  consolidateMarketIndicators,
} from "./market-consolidate";
import type {
  MarketIndicator,
  MarketIndicatorLine,
  MarketIndicatorValue,
  MarketIndicatorItem,
} from "@workspace/db";
describe("monthIdsOf / monthPairsOf", () => {
  it("expande FY em 12 meses e trimestre em 3, preservando a versão", () => {
    expect(monthIdsOf("fy26_fy_budget")).toHaveLength(12);
    expect(monthIdsOf("fy26_fy_budget")[0]).toBe("fy26_m01_budget");
    expect(monthIdsOf("fy26_q2_mrf7")).toEqual([
      "fy26_m04_mrf7",
      "fy26_m05_mrf7",
      "fy26_m06_mrf7",
    ]);
    expect(monthIdsOf("fy26_m03_actual")).toEqual(["fy26_m03_actual"]);
  });
  it("pareia mês i da origem com mês i do destino", () => {
    const pairs = monthPairsOf("fy26_q1_budget", "fy26_q1_mrf7")!;
    expect(pairs).toHaveLength(3);
    expect(pairs[1]).toEqual({
      sourceId: "fy26_m02_budget",
      targetId: "fy26_m02_mrf7",
      label: "FEB26",
    });
  });
  it("granularidades diferentes não pareiam — nunca trunca o intervalo", () => {
    expect(monthPairsOf("fy26_fy_budget", "fy26_q1_mrf7")).toBeNull();
    expect(monthPairsOf("fy26_q1_budget", "fy26_m01_mrf7")).toBeNull();
    // mesma granularidade, períodos diferentes: pareamento ordinal válido
    const q1q2 = monthPairsOf("fy26_q1_budget", "fy26_q2_budget")!;
    expect(q1q2.map((p) => p.sourceId)).toEqual([
      "fy26_m01_budget",
      "fy26_m02_budget",
      "fy26_m03_budget",
    ]);
    expect(q1q2.map((p) => p.label)).toEqual(["APR26", "MAY26", "JUN26"]);
  });
  it("rotula meses corretamente", () => {
    expect(monthLabelOf("fy26_m01_mrf7")).toBe("JAN26");
    expect(monthLabelOf("fy26_m12_mrf7")).toBe("DEC26");
  });
});

function indicator(id: number, title = "Iron Ores"): MarketIndicator {
  return { id, title, unitLabel: "Price $/t", sortOrder: 0 };
}
function line(
  id: number,
  indicatorId: number,
  label: string,
  extra: Partial<MarketIndicatorLine> = {},
): MarketIndicatorLine {
  return { id, indicatorId, label, kind: "price", direction: -1, sortOrder: 0, ...extra };
}
let valueId = 0;
function value(
  lineId: number,
  scenarioId: string,
  v: number | null,
  volumeKt: number | null = null,
): MarketIndicatorValue {
  return { id: ++valueId, lineId, scenarioId, value: v, volumeKt };
}
const item = (id: number, indicatorId: number, it: string): MarketIndicatorItem => ({
  id,
  indicatorId,
  item: it,
});

describe("consolidateMarketIndicators", () => {
  const requested = { sourceId: "fy26_q1_budget", targetId: "fy26_q1_mrf7" };
  const pairs = monthPairsOf(requested.sourceId, requested.targetId)!;

  it("calcula variação e impacto na leitura (preço: direção × var × kt do destino)", () => {
    const req = { sourceId: "fy26_m01_budget", targetId: "fy26_m01_mrf7" };
    const p = monthPairsOf(req.sourceId, req.targetId)!;
    const inds = [indicator(1)];
    const lines = [line(10, 1, "Pellet premium")];
    const values = [
      value(10, "fy26_m01_budget", 30, 1.8),
      value(10, "fy26_m01_mrf7", 37, 2),
    ];
    const [c] = consolidateMarketIndicators(req, p, inds, lines, values, []);
    const l = c.lines[0];
    expect(l.sourceValue).toBe(30);
    expect(l.targetValue).toBe(37);
    expect(l.varValue).toBe(7);
    expect(l.volumeKt).toBe(2); // kt do mês destino
    expect(l.impactMusd).toBeCloseTo(-1 * 7 * 2);
    expect(c.totalMusd).toBeCloseTo(-14);
  });

  it("direção +1 (benefício) e linhas de montante (MUSD) sem kt", () => {
    const req = { sourceId: "fy26_m01_budget", targetId: "fy26_m01_mrf7" };
    const p = monthPairsOf(req.sourceId, req.targetId)!;
    const inds = [indicator(1)];
    const lines = [
      line(10, 1, "Netback freight", { direction: 1 }),
      line(11, 1, "Forex (contract)", { kind: "amount" }),
    ];
    const values = [
      value(10, "fy26_m01_budget", 16, 0.5),
      value(10, "fy26_m01_mrf7", 20, 0.5),
      value(11, "fy26_m01_budget", 0),
      value(11, "fy26_m01_mrf7", 0.5),
    ];
    const [c] = consolidateMarketIndicators(req, p, inds, lines, values, []);
    expect(c.lines.find((l) => l.label === "Netback freight")!.impactMusd).toBeCloseTo(2);
    const forex = c.lines.find((l) => l.label === "Forex (contract)")!;
    expect(forex.impactMusd).toBeCloseTo(-0.5);
    // montante: colunas de preço ficam vazias no pop-up
    expect(forex.sourceValue).toBeUndefined();
    expect(forex.varValue).toBeUndefined();
  });

  it("soma impactos e kt entre meses, omite preços em pares multi-mês", () => {
    const inds = [indicator(1)];
    const lines = [line(10, 1, "Pellet premium")];
    const values = [
      value(10, "fy26_m01_budget", 30, 2),
      value(10, "fy26_m01_mrf7", 35, 2),
      value(10, "fy26_m02_budget", 31, 3.5),
      value(10, "fy26_m02_mrf7", 38, 3.5),
    ];
    const items = [item(1, 1, "Fines"), item(2, 1, "Pellets")];
    const [c] = consolidateMarketIndicators(requested, pairs, inds, lines, values, items);
    expect(c.sourceId).toBe("fy26_q1_budget");
    const pellet = c.lines[0];
    expect(pellet.impactMusd).toBeCloseTo(-(5 * 2) - 7 * 3.5);
    expect(pellet.volumeKt).toBeCloseTo(5.5);
    expect(pellet.sourceValue).toBeUndefined();
    expect(pellet.varValue).toBeUndefined();
    expect(c.items.sort()).toEqual(["Fines", "Pellets"]);
    expect(c.months.map((m) => m.periodLabel)).toEqual(["JAN26", "FEB26"]);
    expect(c.months[0].totalMusd).toBeCloseTo(-10);
    // detalhe mensal preserva os preços
    expect(c.months[0].lines[0].sourceValue).toBe(30);
    expect(c.months[0].lines[0].varValue).toBe(5);
  });

  it("kt vem só do mês destino — sem kt no destino, impacto zero", () => {
    const req = { sourceId: "fy26_m01_budget", targetId: "fy26_m01_mrf7" };
    const p = monthPairsOf(req.sourceId, req.targetId)!;
    const [c] = consolidateMarketIndicators(
      req,
      p,
      [indicator(1)],
      [line(10, 1, "Pellet premium")],
      [value(10, "fy26_m01_budget", 30, 2), value(10, "fy26_m01_mrf7", 37, null)],
      [],
    );
    const l = c.lines[0];
    expect(l.varValue).toBe(7);
    expect(l.volumeKt).toBeUndefined();
    expect(l.impactMusd).toBe(0);
  });

  it("valor de um lado só aparece sem variação nem impacto", () => {
    const req = { sourceId: "fy26_m01_budget", targetId: "fy26_m01_mrf7" };
    const p = monthPairsOf(req.sourceId, req.targetId)!;
    const [c] = consolidateMarketIndicators(
      req,
      p,
      [indicator(1)],
      [line(10, 1, "Pellet premium")],
      [value(10, "fy26_m01_mrf7", 37, 2)],
      [],
    );
    const l = c.lines[0];
    expect(l.sourceValue).toBeUndefined();
    expect(l.targetValue).toBe(37);
    expect(l.varValue).toBeUndefined();
    expect(l.impactMusd).toBe(0);
  });

  it("títulos diferentes não se misturam e meses sem dados ficam de fora", () => {
    const inds = [indicator(1, "Iron Ores"), indicator(2, "Coking Coal")];
    const lines = [line(10, 1, "A"), line(11, 2, "B")];
    const values = [
      value(10, "fy26_m01_budget", 5, 1),
      value(10, "fy26_m01_mrf7", 6, 1),
      value(11, "fy26_m01_budget", 9, 1),
      value(11, "fy26_m01_mrf7", 8, 1),
    ];
    const out = consolidateMarketIndicators(requested, pairs, inds, lines, values, []);
    expect(out.map((e) => e.title)).toEqual(["Iron Ores", "Coking Coal"]);
    expect(out[0].months).toHaveLength(1);
    expect(out[0].months[0].periodLabel).toBe("JAN26");
  });

  it("ignora valores de meses fora do intervalo pedido", () => {
    const values = [
      value(10, "fy26_m07_budget", 5, 1),
      value(10, "fy26_m07_mrf7", 6, 1),
    ];
    const out = consolidateMarketIndicators(
      requested,
      pairs,
      [indicator(1)],
      [line(10, 1, "A")],
      values,
      [],
    );
    expect(out).toHaveLength(0);
  });
});
