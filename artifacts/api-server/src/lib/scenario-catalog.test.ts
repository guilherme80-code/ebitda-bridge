import { describe, expect, it } from "vitest";
import { defaultScenarioPair } from "./scenario-catalog";
import type { Scenario } from "@workspace/db";

const scenario = (id: string, version: string): Scenario => ({
  id,
  version,
  period: id.includes("_fy_") ? "FY" : "JAN",
  periodKind: id.includes("_fy_") ? "year" : "month",
  label: id,
  sortOrder: 0,
});

describe("defaultScenarioPair", () => {
  it("escolhe primeiro e último FY em ordem de ano quando a preferência FY26 não existe", () => {
    const scenarios = [
      scenario("fy37_fy_budget", "BUDGET"),
      scenario("fy26_fy_mrf12", "MRF12"),
    ];
    const withData = new Set(scenarios.map((s) => s.id));

    expect(defaultScenarioPair(scenarios, withData)).toEqual({
      sourceId: "fy26_fy_mrf12",
      targetId: "fy37_fy_budget",
    });
  });
});