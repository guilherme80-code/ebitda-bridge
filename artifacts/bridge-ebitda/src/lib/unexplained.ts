import type { BridgeStep } from '@workspace/api-client-react';

/** Resíduos menores que isso (MUSD) são tratados como "tudo explicado". */
export const UNEXPLAINED_EPS = 0.05;

/**
 * Insere a coluna "Não Explicado" imediatamente antes do EBITDA destino
 * (passo total_end). O resíduo é calculado a partir dos totais DA PRÓPRIA
 * série (original ou simulada), descontando a soma das explicações
 * registradas — que não variam com a simulação:
 *   resíduo    = (destino − origem) − explicado
 *   cumulative = EBITDA destino da série
 *   value      = resíduo
 *   início     = cumulative − value = origem + explicado
 * Sem explicações, a barra cobre toda a variação (origem → destino); quando
 * o resíduo é ~zero, a coluna não aparece. `explainedTotal === undefined`
 * (explicações ainda não carregadas) também omite a coluna.
 */
export function insertUnexplainedStep(
  steps: BridgeStep[],
  explainedTotal: number | undefined,
): BridgeStep[] {
  if (explainedTotal === undefined) return steps;
  const start = steps.find((s) => s.kind === 'total_start');
  const endIdx = steps.findIndex((s) => s.kind === 'total_end');
  if (!start || endIdx < 0) return steps;
  const end = steps[endIdx];
  const unexplained = end.value - start.value - explainedTotal;
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
