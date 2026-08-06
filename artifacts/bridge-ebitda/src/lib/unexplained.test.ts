import { describe, it, expect } from 'vitest';
import { insertUnexplainedStep, residualToExplain, UNEXPLAINED_EPS } from './unexplained';
import type { BridgeStep } from '@workspace/api-client-react';

// Bridge com alavancas nomeadas + plug "Estoque / Outros" (sv_others).
const steps: BridgeStep[] = [
  { key: 'ebitda_source', label: 'EBITDA FY26 Budget', value: 632, cumulative: 632, kind: 'total_start', hasDetail: false },
  { key: 'selling_price', label: 'Preço de venda', value: 100, cumulative: 732, kind: 'delta', hasDetail: true },
  { key: 'fx', label: 'Câmbio', value: 25.8, cumulative: 757.8, kind: 'delta', hasDetail: true },
  { key: 'sv_others', label: 'Estoque / Outros', value: -10.2, cumulative: 747.6, kind: 'delta', hasDetail: true },
  { key: 'ebitda_target', label: 'EBITDA FY26 MRF7', value: 747.6, cumulative: 747.6, kind: 'total_end', hasDetail: false },
];
const residual = -10.2; // valor de Estoque / Outros

// Série simulada: alavanca ajustada muda o destino; plug permanece o mesmo.
const simSteps: BridgeStep[] = [
  { key: 'ebitda_source', label: 'EBITDA FY26 Budget', value: 632, cumulative: 632, kind: 'total_start', hasDetail: false },
  { key: 'selling_price', label: 'Preço de venda', value: 112.4, cumulative: 744.4, kind: 'delta', hasDetail: true },
  { key: 'fx', label: 'Câmbio', value: 25.8, cumulative: 770.2, kind: 'delta', hasDetail: true },
  { key: 'sv_others', label: 'Estoque / Outros', value: -10.2, cumulative: 760, kind: 'delta', hasDetail: true },
  { key: 'ebitda_target', label: 'EBITDA FY26 MRF7', value: 760, cumulative: 760, kind: 'total_end', hasDetail: false },
];

describe('residualToExplain', () => {
  it('retorna o valor do passo Estoque / Outros', () => {
    expect(residualToExplain(steps)).toBeCloseTo(-10.2, 10);
  });
  it('retorna undefined quando o passo não existe', () => {
    expect(residualToExplain(steps.filter((s) => s.key !== 'sv_others'))).toBeUndefined();
  });
});

describe('insertUnexplainedStep', () => {
  it('sem explicações: coluna mostra o residual das alavancas (= Estoque / Outros), não a variação total', () => {
    const out = insertUnexplainedStep(steps, 0);
    expect(out).toHaveLength(steps.length + 1);
    const idx = out.findIndex((s) => s.key === 'unexplained');
    expect(idx).toBe(out.findIndex((s) => s.kind === 'total_end') - 1);
    const step = out[idx];
    expect(step.value).toBeCloseTo(residual, 10);
    // Barra termina no EBITDA destino
    expect(step.cumulative).toBeCloseTo(747.6, 10);
    // A coluna "Estoque / Outros" continua presente
    expect(out.find((s) => s.key === 'sv_others')).toBeDefined();
  });

  it('explicação parcial: resíduo = residual − explicado', () => {
    const explained = -4;
    const out = insertUnexplainedStep(steps, explained);
    const step = out.find((s) => s.key === 'unexplained')!;
    expect(step.value).toBeCloseTo(residual - explained, 10); // -6.2
    expect(step.cumulative).toBeCloseTo(747.6, 10);
  });

  it('tudo explicado (resíduo ~zero): coluna não aparece', () => {
    expect(insertUnexplainedStep(steps, residual)).toEqual(steps);
    expect(insertUnexplainedStep(steps, residual - UNEXPLAINED_EPS / 2)).toEqual(steps);
    expect(insertUnexplainedStep(steps, residual + UNEXPLAINED_EPS / 2)).toEqual(steps);
  });

  it('explicado além do residual: resíduo restante com sinal oposto', () => {
    const out = insertUnexplainedStep(steps, residual - 5);
    const step = out.find((s) => s.key === 'unexplained')!;
    expect(step.value).toBeCloseTo(5, 10);
  });

  it('modo simulação: cada série usa seu próprio residual e fecha no seu destino', () => {
    const explained = -4;
    const original = insertUnexplainedStep(steps, explained).find((s) => s.key === 'unexplained')!;
    const simulated = insertUnexplainedStep(simSteps, explained).find((s) => s.key === 'unexplained')!;
    expect(original.value).toBeCloseTo(residual - explained, 10);
    expect(original.cumulative).toBeCloseTo(747.6, 10);
    expect(simulated.value).toBeCloseTo(residual - explained, 10);
    expect(simulated.cumulative).toBeCloseTo(760, 10);
  });

  it('excluir explicações (resíduo volta a crescer) reinsere a coluna', () => {
    const none = insertUnexplainedStep(steps, residual);
    expect(none.find((s) => s.key === 'unexplained')).toBeUndefined();
    const back = insertUnexplainedStep(steps, 0);
    expect(back.find((s) => s.key === 'unexplained')).toBeDefined();
  });

  it('explicações ainda não carregadas (undefined) ou série sem residual: lista inalterada', () => {
    expect(insertUnexplainedStep(steps, undefined)).toEqual(steps);
    const noPlug = steps.filter((s) => s.key !== 'sv_others');
    expect(insertUnexplainedStep(noPlug, 0)).toEqual(noPlug);
  });
});
