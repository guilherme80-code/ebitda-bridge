import type { BridgeStep } from '@workspace/api-client-react';

/** Resíduos menores que isso (MUSD) são tratados como "tudo explicado". */
export const UNEXPLAINED_EPS = 0.05;

/**
 * Chave do passo "Não Explicado" que o servidor insere no bridge apenas
 * quando os dados da fonte não fecham a passagem (diferença ≥ 0,05 MUSD).
 * Quando o bridge fecha pela fonte, o passo não existe.
 */
export const UNEXPLAINED_STEP_KEY = 'unexplained';

/**
 * Diferença de fechamento da série (valor do passo "Não Explicado" vindo do
 * servidor). undefined quando o bridge fecha pela fonte — nesse caso não há
 * coluna nem painel de explicações.
 */
export function discrepancyOf(steps: BridgeStep[]): number | undefined {
  return steps.find((s) => s.key === UNEXPLAINED_STEP_KEY)?.value;
}

/**
 * Desconta as explicações registradas do passo "Não Explicado" DA PRÓPRIA
 * série (as explicações não variam com a simulação):
 *   resíduo = diferença de fechamento − explicado
 * O passo ajustado começa onde a alavanca anterior terminou (cumulative =
 * cumulative anterior + resíduo), mantendo a cadeia de barras contínua; a
 * parte explicada aparece como o degrau restante até o EBITDA destino.
 * Quando o resíduo é ~zero, o passo some do gráfico. Sem passo "Não
 * Explicado" (bridge fecha pela fonte) ou com `explainedTotal === undefined`
 * (explicações ainda não carregadas), os passos ficam como vieram.
 */
export function applyExplanations(
  steps: BridgeStep[],
  explainedTotal: number | undefined,
): BridgeStep[] {
  if (explainedTotal === undefined) return steps;
  const idx = steps.findIndex((s) => s.key === UNEXPLAINED_STEP_KEY);
  if (idx < 0) return steps;
  const remainder = steps[idx].value - explainedTotal;
  if (Math.abs(remainder) < UNEXPLAINED_EPS) {
    return [...steps.slice(0, idx), ...steps.slice(idx + 1)];
  }
  if (Math.abs(remainder - steps[idx].value) < 1e-12) return steps;
  const prevCumulative =
    idx > 0 ? steps[idx - 1].cumulative : steps[idx].cumulative - steps[idx].value;
  return [
    ...steps.slice(0, idx),
    { ...steps[idx], value: remainder, cumulative: prevCumulative + remainder },
    ...steps.slice(idx + 1),
  ];
}
