import { describe, expect, it } from 'vitest';
import { scenarioVersions } from './scenario-versions';

describe('scenarioVersions', () => {
  it('mostra MRF8 mesmo quando ainda não há cenário importado para ela', () => {
    expect(scenarioVersions([])).toContain('MRF8');
  });

  it('mantém as versões suportadas na ordem do catálogo', () => {
    expect(scenarioVersions([])).toEqual([
      'ACTUAL',
      'BUDGET',
      'MRF1',
      'MRF2',
      'MRF3',
      'MRF4',
      'MRF5',
      'MRF6',
      'MRF7',
      'MRF8',
      'MRF9',
      'MRF10',
      'MRF11',
      'MRF12',
    ]);
  });
});