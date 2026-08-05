/**
 * Testes de regressão do motor de cálculo do bridge (bridge-calc.ts) contra
 * os valores conhecidos da aba "Cálculo" do Modelo Bridge.xlsx para o par
 * padrão FY26 Budget → FY26 MRF7, usando o seed real (bridge-seed.json).
 *
 * Se qualquer fórmula do motor mudar de comportamento, os totais abaixo
 * (start, end e efeito por alavanca, em MUSD) deixam de bater e o teste
 * falha — evitando regressões silenciosas.
 */
import { describe, it, expect } from "vitest";
import { computeBridge } from "./bridge-calc";
import { loadScenario } from "./seed-fixture";

const source = loadScenario("fy26_fy_budget"); // FY26 Budget
const target = loadScenario("fy26_fy_mrf7"); // FY26 MRF7
const bridge = computeBridge(source, target);

// Valores de referência do Excel (MUSD), conferidos contra a aba Cálculo.
const EXPECTED = {
  start: 632.044044529875,
  end: 747.6924008767779,
  drivers: {
    vol_mix: -6.680380721635167,
    selling_price: 286.5489436934464,
    input_price: -177.47194678166554,
    usage: -12.829343372386798,
    fixed_cost: -34.29055851516909,
    forex: 70.57285860656948,
    sv_others: -10.201216562256391,
  },
};

describe("computeBridge — FY26 Budget → FY26 MRF7 (regressão vs Excel)", () => {
  it("start (EBITDA origem) bate com o Excel", () => {
    expect(bridge.start).toBeCloseTo(EXPECTED.start, 6);
  });

  it("end (EBITDA destino) bate com o Excel", () => {
    expect(bridge.end).toBeCloseTo(EXPECTED.end, 6);
  });

  it("tem exatamente as alavancas esperadas", () => {
    expect(Object.keys(bridge.drivers).sort()).toEqual(
      Object.keys(EXPECTED.drivers).sort(),
    );
  });

  for (const [key, value] of Object.entries(EXPECTED.drivers)) {
    it(`alavanca ${key} bate com o Excel`, () => {
      expect(bridge.drivers[key]).toBeCloseTo(value, 6);
    });
  }

  it("o bridge fecha: start + soma das alavancas = end", () => {
    const sum = Object.values(bridge.drivers).reduce((s, v) => s + v, 0);
    expect(bridge.start + sum).toBeCloseTo(bridge.end, 9);
  });
});
