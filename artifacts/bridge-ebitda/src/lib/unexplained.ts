import type { BridgeStep } from '@workspace/api-client-react';

/** Resíduos menores que isso (MUSD) são tratados como "tudo explicado". */
export const UNEXPLAINED_EPS = 0.05;

/**
 * Chave do passo "Não Explicado" que o servidor insere no bridge apenas
 * quando os dados da fonte não fecham a passagem (diferença ≥ 0,05 MUSD).
 * Quando o bridge fecha pela fonte, o passo não existe.
 */
export const UNEXPLAINED_STEP_KEY = 'unexplained';

/** Chave do passo "Outros" (ou "Estoque / Outros"), que absorve o explicado. */
export const OTHERS_STEP_KEY = 'sv_others';

/**
 * Diferença de fechamento da série (valor do passo "Não Explicado" vindo do
 * servidor). undefined quando o bridge fecha pela fonte — nesse caso não há
 * coluna nem painel de explicações.
 */
export function discrepancyOf(steps: BridgeStep[]): number | undefined {
  return steps.find((s) => s.key === UNEXPLAINED_STEP_KEY)?.value;
}

/**
 * Saldo que ainda falta explicar (MUSD): diferença da fonte − explicado.
 * Resíduos menores que UNEXPLAINED_EPS são tratados como zero (tudo
 * explicado), o mesmo limiar que faz a coluna "Não Explicado" sumir.
 */
export function remainingToExplain(residual: number, explained: number): number {
  const r = residual - explained;
  return Math.abs(r) < UNEXPLAINED_EPS ? 0 : r;
}

export type StepWithExplanation = BridgeStep & {
  /**
   * Parte do valor do passo que vem de explicações registradas (MUSD),
   * anotada no passo "Outros" para marcação no gráfico e no tooltip.
   */
  explainedMusd?: number;
};

/**
 * Aplica as explicações registradas aos passos DA PRÓPRIA série (as
 * explicações não variam com a simulação), mantendo o waterfall contínuo e
 * fechando exatamente no EBITDA destino:
 *   - a parte explicada é SOMADA na barra "Outros" (valor da fonte +
 *     explicado), anotada em `explainedMusd`;
 *   - "Não Explicado" fica só com o resíduo (diferença − explicado) e some
 *     quando o resíduo é ~zero;
 *   - os acumulados entre "Outros" e o EBITDA destino são recalculados para
 *     a cadeia fechar no destino.
 * Sem passo "Não Explicado" (bridge fecha pela fonte) ou com
 * `explainedTotal === undefined` (ainda carregando), os passos ficam como
 * vieram.
 */
export function applyExplanations(
  steps: BridgeStep[],
  explainedTotal: number | undefined,
): StepWithExplanation[] {
  if (explainedTotal === undefined) return steps;
  const unexpIdx = steps.findIndex((s) => s.key === UNEXPLAINED_STEP_KEY);
  if (unexpIdx < 0) return steps;
  if (Math.abs(explainedTotal) < 1e-12) return steps;

  const remainder = steps[unexpIdx].value - explainedTotal;
  const othersIdx = steps.findIndex((s) => s.key === OTHERS_STEP_KEY);
  // Sem a barra "Outros" para absorver o explicado não há como manter a
  // cadeia fechando no destino — mantém os passos como vieram do servidor.
  if (othersIdx < 0) return steps;

  const out: StepWithExplanation[] = steps.map((s) => ({ ...s }));

  // Resíduo restante em "Não Explicado"; some quando ~zero.
  const dropUnexplained = Math.abs(remainder) < UNEXPLAINED_EPS;

  // Soma o explicado em "Outros". Se a coluna "Não Explicado" for sumir,
  // "Outros" absorve também o resíduo ~zero para a cadeia fechar exatamente
  // no destino.
  const absorbed = dropUnexplained ? explainedTotal + remainder : explainedTotal;
  out[othersIdx].value += absorbed;
  (out[othersIdx] as StepWithExplanation).explainedMusd = absorbed;

  out[unexpIdx].value = remainder;

  // Recalcula os acumulados dos deltas a partir do primeiro passo alterado,
  // para a cadeia continuar contínua e fechar no EBITDA destino.
  const firstChanged = Math.min(othersIdx, unexpIdx);
  for (let i = firstChanged; i < out.length; i++) {
    if (out[i].kind !== 'delta') continue;
    const prev = out[i - 1];
    out[i].cumulative = (prev ? prev.cumulative : 0) + out[i].value;
  }

  return dropUnexplained
    ? [...out.slice(0, unexpIdx), ...out.slice(unexpIdx + 1)]
    : out;
}
