import type { BridgeStep } from '@workspace/api-client-react';

/** Resíduos menores que isso (MUSD) são tratados como "tudo explicado". */
export const UNEXPLAINED_EPS = 0.05;

/**
 * Chave do passo de residual/plug no bridge. Quando os dados trazem Stock
 * Variation, este passo é apenas "Outros" (o "Estoque" vira alavanca própria,
 * com o valor real dos dados); sem Stock Variation é o plug único
 * "Estoque / Outros".
 */
export const RESIDUAL_STEP_KEY = 'sv_others';

/**
 * Residual a explicar da série: o valor do passo de plug ("Outros", ou
 * "Estoque / Outros" quando não há Stock Variation nos dados) — variação
 * total − alavancas nomeadas. Retorna undefined se o passo não existir.
 */
export function residualToExplain(steps: BridgeStep[]): number | undefined {
  const plug = steps.find((s) => s.key === RESIDUAL_STEP_KEY);
  return plug?.value;
}

/**
 * Insere a coluna "Não Explicado" imediatamente antes do EBITDA destino
 * (passo total_end). A base é o residual das alavancas nomeadas DA PRÓPRIA
 * série (o valor do passo de plug "Outros"), descontando a soma das explicações
 * registradas — que não variam com a simulação:
 *   resíduo    = residual (Estoque / Outros) − explicado
 *   cumulative = EBITDA destino da série
 *   value      = resíduo
 *   início     = cumulative − value
 * Quando o resíduo é ~zero, a coluna não aparece. `explainedTotal ===
 * undefined` (explicações ainda não carregadas) ou série sem o passo de
 * residual também omitem a coluna.
 */
export function insertUnexplainedStep(
  steps: BridgeStep[],
  explainedTotal: number | undefined,
): BridgeStep[] {
  if (explainedTotal === undefined) return steps;
  const residual = residualToExplain(steps);
  const endIdx = steps.findIndex((s) => s.kind === 'total_end');
  if (residual === undefined || endIdx < 0) return steps;
  const end = steps[endIdx];
  const unexplained = residual - explainedTotal;
  if (Math.abs(unexplained) < UNEXPLAINED_EPS) return steps;
  const step: BridgeStep = {
    key: 'unexplained',
    label: 'Não Explicado',
    value: unexplained,
    cumulative: end.value,
    kind: 'delta',
    hasDetail: false,
  };
  return [...steps.slice(0, endIdx), step, ...steps.slice(endIdx)];
}
