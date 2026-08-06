import { describe, it, expect } from 'vitest';
import { applyExplanations, discrepancyOf, UNEXPLAINED_EPS } from './unexplained';
import type { BridgeStep } from '@workspace/api-client-react';

// Bridge que FECHA pela fonte: sem passo "Não Explicado" vindo do servidor.
const closedSteps: BridgeStep[] = [
  { key: 'ebitda_source', label: 'EBITDA FY26 Budget', value: 632, cumulative: 632, kind: 'total_start', hasDetail: false },
  { key: 'selling_price', label: 'Preço de venda', value: 100, cumulative: 732, kind: 'delta', hasDetail: true },
  { key: 'fx', label: 'Câmbio', value: 25.9, cumulative: 757.9, kind: 'delta', hasDetail: true },
  { key: 'sv_others', label: 'Estoque / Outros', value: -10.2, cumulative: 747.7, kind: 'delta', hasDetail: true },
  { key: 'ebitda_target', label: 'EBITDA FY26 MRF7', value: 747.7, cumulative: 747.7, kind: 'total_end', hasDetail: false },
];

// Bridge que NÃO fecha: o servidor incluiu o passo "Não Explicado" (-6.2)
// logo antes do EBITDA destino.
const discrepancy = -6.2;
const openSteps: BridgeStep[] = [
  { key: 'ebitda_source', label: 'EBITDA FY26 Budget', value: 632, cumulative: 632, kind: 'total_start', hasDetail: false },
  { key: 'selling_price', label: 'Preço de venda', value: 100, cumulative: 732, kind: 'delta', hasDetail: true },
  { key: 'stock', label: 'Estoque', value: 15, cumulative: 747, kind: 'delta', hasDetail: true },
  { key: 'sv_others', label: 'Outros', value: 6.9, cumulative: 753.9, kind: 'delta', hasDetail: true },
  { key: 'unexplained', label: 'Não Explicado', value: discrepancy, cumulative: 747.7, kind: 'delta', hasDetail: false },
  { key: 'ebitda_target', label: 'EBITDA FY26 MRF7', value: 747.7, cumulative: 747.7, kind: 'total_end', hasDetail: false },
];

// Série simulada correspondente (destino diferente, mesma diferença).
const simOpenSteps: BridgeStep[] = openSteps.map((s) =>
  s.kind === 'delta' && s.key === 'selling_price'
    ? { ...s, value: 112.4, cumulative: 744.4 }
    : s.key === 'stock'
      ? { ...s, cumulative: 759.4 }
      : s.key === 'sv_others'
        ? { ...s, cumulative: 766.3 }
        : s.key === 'unexplained'
          ? { ...s, cumulative: 760.1 }
          : s.kind === 'total_end'
            ? { ...s, value: 760.1, cumulative: 760.1 }
            : s,
);

describe('discrepancyOf', () => {
  it('retorna o valor do passo Não Explicado quando o bridge não fecha', () => {
    expect(discrepancyOf(openSteps)).toBeCloseTo(discrepancy, 10);
  });
  it('retorna undefined quando o bridge fecha pela fonte', () => {
    expect(discrepancyOf(closedSteps)).toBeUndefined();
  });
});

describe('applyExplanations', () => {
  it('bridge fechado: passos ficam intactos, sem coluna Não Explicado', () => {
    expect(applyExplanations(closedSteps, 0)).toEqual(closedSteps);
    expect(applyExplanations(closedSteps, -4)).toEqual(closedSteps);
  });

  it('sem explicações: coluna mostra a diferença de fechamento inteira', () => {
    const out = applyExplanations(openSteps, 0);
    const idx = out.findIndex((s) => s.key === 'unexplained');
    expect(idx).toBe(out.findIndex((s) => s.kind === 'total_end') - 1);
    expect(out[idx].value).toBeCloseTo(discrepancy, 10);
    expect(out[idx].cumulative).toBeCloseTo(747.7, 10);
  });

  it('explicação parcial: resíduo = diferença − explicado, cadeia contínua', () => {
    const out = applyExplanations(openSteps, -4);
    const idx = out.findIndex((s) => s.key === 'unexplained');
    const step = out[idx];
    expect(step.value).toBeCloseTo(discrepancy - -4, 10); // -2.2
    // A barra começa onde a alavanca anterior terminou (753.9) e termina em
    // 753.9 − 2.2 = 751.7; o degrau até 747.7 é a parte explicada.
    expect(step.cumulative).toBeCloseTo(out[idx - 1].cumulative + step.value, 10);
    expect(step.cumulative).toBeCloseTo(751.7, 10);
    // A parte já explicada fica anotada no passo, para marcação no gráfico.
    expect(step.explainedMusd).toBeCloseTo(-4, 10);
  });

  it('tudo explicado (resíduo ~zero): coluna some', () => {
    const gone = applyExplanations(openSteps, discrepancy);
    expect(gone.find((s) => s.key === 'unexplained')).toBeUndefined();
    expect(gone).toHaveLength(openSteps.length - 1);
    expect(applyExplanations(openSteps, discrepancy - UNEXPLAINED_EPS / 2).find((s) => s.key === 'unexplained')).toBeUndefined();
    expect(applyExplanations(openSteps, discrepancy + UNEXPLAINED_EPS / 2).find((s) => s.key === 'unexplained')).toBeUndefined();
  });

  it('explicado além da diferença: resíduo restante com sinal oposto', () => {
    const out = applyExplanations(openSteps, discrepancy - 5);
    expect(out.find((s) => s.key === 'unexplained')!.value).toBeCloseTo(5, 10);
  });

  it('modo simulação: cada série desconta as mesmas explicações a partir da sua própria cadeia', () => {
    const explained = -4;
    const original = applyExplanations(openSteps, explained).find((s) => s.key === 'unexplained')!;
    const simulated = applyExplanations(simOpenSteps, explained).find((s) => s.key === 'unexplained')!;
    expect(original.value).toBeCloseTo(discrepancy - explained, 10);
    expect(original.cumulative).toBeCloseTo(753.9 + (discrepancy - explained), 10);
    expect(simulated.value).toBeCloseTo(discrepancy - explained, 10);
    expect(simulated.cumulative).toBeCloseTo(766.3 + (discrepancy - explained), 10);
  });

  it('sem explicações (0): passos ficam idênticos aos do servidor (cadeia fecha no destino)', () => {
    expect(applyExplanations(openSteps, 0)).toEqual(openSteps);
  });

  it('excluir explicações (resíduo volta a crescer) reinsere a coluna', () => {
    expect(applyExplanations(openSteps, discrepancy).find((s) => s.key === 'unexplained')).toBeUndefined();
    expect(applyExplanations(openSteps, 0).find((s) => s.key === 'unexplained')).toBeDefined();
  });

  it('explicações ainda não carregadas (undefined): lista inalterada', () => {
    expect(applyExplanations(openSteps, undefined)).toEqual(openSteps);
    expect(applyExplanations(closedSteps, undefined)).toEqual(closedSteps);
  });
});
