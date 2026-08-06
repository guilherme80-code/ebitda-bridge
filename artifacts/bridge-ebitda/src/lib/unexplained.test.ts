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

/** A cadeia é contínua e fecha exatamente no EBITDA destino. */
function expectChainCloses(steps: BridgeStep[]) {
  for (let i = 1; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== 'delta') continue;
    expect(s.cumulative).toBeCloseTo(steps[i - 1].cumulative + s.value, 9);
  }
  const end = steps[steps.length - 1];
  const lastDelta = [...steps].reverse().find((s) => s.kind === 'delta')!;
  expect(lastDelta.cumulative).toBeCloseTo(end.value, 9);
}

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

  it('sem explicações (0): passos idênticos aos do servidor, cadeia fecha', () => {
    const out = applyExplanations(openSteps, 0);
    expect(out).toEqual(openSteps);
    expectChainCloses(out);
  });

  it('explicação parcial: explicado soma em Outros, resíduo em Não Explicado, cadeia fecha', () => {
    const explained = -4;
    const out = applyExplanations(openSteps, explained);
    const others = out.find((s) => s.key === 'sv_others')!;
    const unexp = out.find((s) => s.key === 'unexplained')!;
    // Outros = valor da fonte + explicado (6.9 − 4 = 2.9), anotando o explicado.
    expect(others.value).toBeCloseTo(6.9 + explained, 10);
    expect((others as { explainedMusd?: number }).explainedMusd).toBeCloseTo(explained, 10);
    expect(others.cumulative).toBeCloseTo(749.9, 10);
    // Não Explicado = diferença − explicado (−2.2), fechando no destino.
    expect(unexp.value).toBeCloseTo(discrepancy - explained, 10);
    expect(unexp.cumulative).toBeCloseTo(747.7, 10);
    expectChainCloses(out);
  });

  it('tudo explicado (resíduo ~zero): coluna some e Outros absorve toda a diferença', () => {
    const out = applyExplanations(openSteps, discrepancy);
    expect(out.find((s) => s.key === 'unexplained')).toBeUndefined();
    expect(out).toHaveLength(openSteps.length - 1);
    const others = out.find((s) => s.key === 'sv_others')!;
    expect(others.value).toBeCloseTo(6.9 + discrepancy, 10); // 0.7
    expect(others.cumulative).toBeCloseTo(747.7, 10);
    expectChainCloses(out);
    // Limiar de ~zero em ambos os lados.
    expectChainCloses(applyExplanations(openSteps, discrepancy - UNEXPLAINED_EPS / 2));
    expectChainCloses(applyExplanations(openSteps, discrepancy + UNEXPLAINED_EPS / 2));
    expect(applyExplanations(openSteps, discrepancy - UNEXPLAINED_EPS / 2).find((s) => s.key === 'unexplained')).toBeUndefined();
  });

  it('explicado além da diferença: resíduo com sinal oposto e cadeia ainda fecha', () => {
    const out = applyExplanations(openSteps, discrepancy - 5);
    const unexp = out.find((s) => s.key === 'unexplained')!;
    expect(unexp.value).toBeCloseTo(5, 10);
    expectChainCloses(out);
  });

  it('modo simulação: cada série soma o mesmo explicado nos próprios passos e fecha no seu destino', () => {
    const explained = -4;
    const original = applyExplanations(openSteps, explained);
    const simulated = applyExplanations(simOpenSteps, explained);
    expectChainCloses(original);
    expectChainCloses(simulated);
    expect(original.find((s) => s.key === 'sv_others')!.value).toBeCloseTo(2.9, 10);
    expect(simulated.find((s) => s.key === 'sv_others')!.value).toBeCloseTo(2.9, 10);
    expect(original.find((s) => s.key === 'unexplained')!.cumulative).toBeCloseTo(747.7, 10);
    expect(simulated.find((s) => s.key === 'unexplained')!.cumulative).toBeCloseTo(760.1, 10);
  });

  it('excluir explicações (resíduo volta a crescer) reinsere a coluna', () => {
    expect(applyExplanations(openSteps, discrepancy).find((s) => s.key === 'unexplained')).toBeUndefined();
    expect(applyExplanations(openSteps, 0).find((s) => s.key === 'unexplained')).toBeDefined();
  });

  it('série sem o passo Outros: passos ficam como vieram do servidor (fechando no destino)', () => {
    const noOthers = openSteps.filter((s) => s.key !== 'sv_others');
    // Série de referência sem Outros (o servidor teria mandado assim, fechada).
    const fixed = noOthers.map((s) =>
      s.key === 'unexplained' ? { ...s, value: 0.7, cumulative: 747.7 } : s,
    );
    // Sem Outros para absorver o explicado, não há como manter o fechamento:
    // nada é ajustado (parcial, total e além da diferença).
    expect(applyExplanations(fixed, 0.5)).toEqual(fixed);
    expect(applyExplanations(fixed, 0.7)).toEqual(fixed);
    expect(applyExplanations(fixed, 1.5)).toEqual(fixed);
    expectChainCloses(applyExplanations(fixed, 0.5));
  });

  it('explicações ainda não carregadas (undefined): lista inalterada', () => {
    expect(applyExplanations(openSteps, undefined)).toEqual(openSteps);
    expect(applyExplanations(closedSteps, undefined)).toEqual(closedSteps);
  });
});
