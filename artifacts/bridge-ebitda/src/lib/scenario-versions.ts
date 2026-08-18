export const SUPPORTED_SCENARIO_VERSIONS = [
  'ACTUAL',
  'BUDGET',
  ...Array.from({ length: 12 }, (_, index) => `MRF${index + 1}`),
] as const;

/**
 * O seletor sempre expõe o catálogo suportado. Versões adicionais presentes
 * em dados antigos continuam visíveis para não esconder uma carga existente.
 */
export function scenarioVersions(
  scenarios: ReadonlyArray<{ version: string }>,
): string[] {
  const supported = new Set<string>(SUPPORTED_SCENARIO_VERSIONS);
  const additional = [...new Set(
    scenarios
      .map((scenario) => scenario.version)
      .filter((version) => !supported.has(version)),
  )];
  return [...SUPPORTED_SCENARIO_VERSIONS, ...additional];
}