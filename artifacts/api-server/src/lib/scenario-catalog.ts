import type { Scenario } from "@workspace/db";
import { compareScenarios } from "./aggregate";

/** Escolhe o par padrão, priorizando o comparativo histórico quando existe. */
export function defaultScenarioPair(scenarios: Scenario[], withData: Set<string>) {
  // Preferência legada: FY26 Budget → FY26 MRF7.
  const preferred = ["fy26_fy_budget", "fy26_fy_mrf7"];
  if (preferred.every((id) => withData.has(id))) {
    return { sourceId: preferred[0], targetId: preferred[1] };
  }

  const years = scenarios
    .filter((s) => s.periodKind === "year" && withData.has(s.id))
    .slice()
    .sort(compareScenarios);
  if (years.length < 2) return undefined;
  return { sourceId: years[0].id, targetId: years[years.length - 1].id };
}