import { describe, it, expect } from 'vitest';
import { insertUnexplainedStep, UNEXPLAINED_EPS } from './unexplained';
import type { BridgeStep } from '@workspace/api-client-react';

const steps: BridgeStep[] = [
  { key: 'ebitda_source', label: 'EBITDA FY26 Budget', value: 632, cumulative: 632, kind: 'total_start', hasDetail: false },
  { key: 'selling_price', label: 'Preço de venda', value: 100, cumulative: 732, kind: 'delta', hasDetail: true },
  { key: 'fx', label: 'Câmbio', value: 15.6, cumulative: 747.6, kind: 'delta', hasDetail: true },
  { key: 'ebitda_target', label: 'EBITDA FY26 MRF7', value: 747.6, cumulative: 747.6, kind: 'total_end', hasDetail: false },
];
const variation = 747.6 - 632; // 115.6

// Série simulada: destino diferente do original (760 em vez de 747.6).
const simSteps: BridgeStep[] = [
  { key: 'ebitda_source', label: 'EBITDA FY26 Budget', value: 632, cumulative: 632, kind: 'total_start', hasDetail: false },
  { key: 'selling_price', label: 'Preço de venda', value: 112.4, cumulative: 744.4, kind: 'delta', hasDetail: true },
  { key: 'fx', label: 'Câmbio', value: 15.6, cumulative: 760, kind: 'delta', hasDetail: true },
  { key: 'ebitda_target', label: 'EBITDA FY26 MRF7', value: 760, cumulative: 760, kind: 'total_end', hasDetail: false },
];

describe('insertUnexplainedStep', () => {
  it('sem explicações: coluna cobre toda a variação, da origem ao destino, antes do total_end', () => {
    const out = insertUnexplainedStep(steps, 0);
    expect(out).toHaveLength(steps.length + 1);
    const idx = out.findIndex((s) => s.key === 'unexplained');
    expect(idx).toBe(out.findIndex((s) => s.kind === 'total_end') - 1);
    const step = out[idx];
    expect(step.value).toBeCloseTo(variation, 10);
    expect(step.cumulative).toBeCloseTo(747.6, 10);
    // Início da barra = cumulative − value = EBITDA origem
    expect(step.cumulative - step.value).toBeCloseTo(632, 10);
  });

  it('explicação parcial: barra parte de origem + explicado e termina no destino', () => {
    const explained = 45.2;
    const out = insertUnexplainedStep(steps, explained);
    const step = out.find((s) => s.key === 'unexplained')!;
    expect(step.value).toBeCloseTo(variation - explained, 10);
    expect(step.cumulative).toBeCloseTo(747.6, 10);
    expect(step.cumulative - step.value).toBeCloseTo(632 + explained, 10);
  });

  it('tudo explicado (resíduo ~zero): coluna não aparece', () => {
    expect(insertUnexplainedStep(steps, variation)).toEqual(steps);
    expect(insertUnexplainedStep(steps, variation - UNEXPLAINED_EPS / 2)).toEqual(steps);
    expect(insertUnexplainedStep(steps, variation + UNEXPLAINED_EPS / 2)).toEqual(steps);
  });

  it('explicado acima da variação: resíduo negativo aparece como delta negativo', () => {
    const out = insertUnexplainedStep(steps, variation + 10);
    const step = out.find((s) => s.key === 'unexplained')!;
    expect(step.value).toBeCloseTo(-10, 10);
    expect(step.cumulative - step.value).toBeCloseTo(747.6 + 10, 10);
  });

  it('modo simulação: cada série calcula seu próprio resíduo e fecha no seu destino', () => {
    const explained = 45.2;
    const original = insertUnexplainedStep(steps, explained).find((s) => s.key === 'unexplained')!;
    const simulated = insertUnexplainedStep(simSteps, explained).find((s) => s.key === 'unexplained')!;
    // Original: resíduo = 115.6 − 45.2, termina em 747.6
    expect(original.value).toBeCloseTo(variation - explained, 10);
    expect(original.cumulative).toBeCloseTo(747.6, 10);
    // Simulada: resíduo = (760 − 632) − 45.2, termina em 760
    expect(simulated.value).toBeCloseTo(760 - 632 - explained, 10);
    expect(simulated.cumulative).toBeCloseTo(760, 10);
    // Em ambas, início = origem + explicado
    expect(original.cumulative - original.value).toBeCloseTo(632 + explained, 10);
    expect(simulated.cumulative - simulated.value).toBeCloseTo(632 + explained, 10);
  });

  it('excluir explicações (resíduo volta a crescer) reinsere a coluna', () => {
    const none = insertUnexplainedStep(steps, variation);
    expect(none.find((s) => s.key === 'unexplained')).toBeUndefined();
    const back = insertUnexplainedStep(steps, 0);
    expect(back.find((s) => s.key === 'unexplained')).toBeDefined();
  });

  it('explicações ainda não carregadas (undefined) ou sem totais: lista inalterada', () => {
    expect(insertUnexplainedStep(steps, undefined)).toEqual(steps);
    const noEnd = steps.filter((s) => s.kind !== 'total_end');
    expect(insertUnexplainedStep(noEnd, 0)).toEqual(noEnd);
  });
});
