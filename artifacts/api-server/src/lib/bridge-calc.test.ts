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

/**
 * Subtotais de grupo das tabelas detalhadas: cada linha "subtotal" deve ser
 * exatamente a soma das linhas-filhas do mesmo grupo, e a linha "Total" deve
 * permanecer a soma de todas as linhas de detalhe (grupos não alteram o total).
 * Colunas não-somáveis (ex.: preços unitários) aparecem como null no subtotal
 * e são ignoradas na conferência.
 */
describe("tabelas detalhadas — subtotais de grupo (dados reais do seed)", () => {
  for (const table of bridge.tables) {
    describe(`tabela ${table.key}`, () => {
      const detailRows = table.rows.filter((r) => r.kind === "row");
      const subtotals = table.rows.filter((r) => r.kind === "subtotal");
      const total = table.rows.find((r) => r.kind === "total");

      it("estrutura: linhas de detalhe alinhadas às colunas", () => {
        for (const row of table.rows) {
          expect(row.values.length).toBe(table.columns.length);
        }
      });

      if (subtotals.length > 0) {
        for (const sub of subtotals) {
          it(`subtotal "${sub.label}" = soma das linhas-filhas`, () => {
            const members = detailRows.filter((r) => r.group === sub.group);
            expect(members.length).toBeGreaterThan(0);
            sub.values.forEach((v, j) => {
              if (v == null) return; // coluna não-somável
              const sum = members.reduce(
                (s, r) => s + (r.values[j] ?? 0),
                0,
              );
              expect(v).toBeCloseTo(sum, 9);
            });
          });
        }

        it("cada linha de detalhe com grupo tem seu subtotal correspondente", () => {
          const subGroups = new Set(subtotals.map((s) => s.group));
          for (const r of detailRows) {
            if (r.group != null) expect(subGroups.has(r.group)).toBe(true);
          }
        });
      }

      if (total) {
        it("Total = soma das linhas de detalhe (grupos não mudam o total)", () => {
          total.values.forEach((v, j) => {
            if (v == null) return;
            const sum = detailRows.reduce((s, r) => s + (r.values[j] ?? 0), 0);
            expect(v).toBeCloseTo(sum, 9);
          });
        });

        it("Total = soma dos subtotais + linhas sem grupo", () => {
          const grouped = new Set(subtotals.map((s) => s.group));
          total.values.forEach((v, j) => {
            if (v == null) return;
            if (subtotals.some((s) => s.values[j] == null)) return; // coluna não-somável nos subtotais
            const sum =
              subtotals.reduce((s, r) => s + (r.values[j] ?? 0), 0) +
              detailRows
                .filter((r) => r.group == null || !grouped.has(r.group))
                .reduce((s, r) => s + (r.values[j] ?? 0), 0);
            expect(v).toBeCloseTo(sum, 9);
          });
        });
      }
    });
  }

  it("as tabelas de vendas e estoque/outros realmente têm grupos (sanidade)", () => {
    for (const key of ["sales", "sv_others"]) {
      const table = bridge.tables.find((t) => t.key === key)!;
      expect(
        table.rows.filter((r) => r.kind === "subtotal").length,
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * O seed atual não traz grupos em custo fixo, insumos e consumo. Para cobrir
 * o caminho de agrupamento dessas tabelas, clonamos os cenários reais
 * atribuindo um groupLabel a cada linha e verificamos que:
 *  1. cada subtotal = soma das linhas-filhas;
 *  2. a linha Total de cada tabela não muda com a presença dos grupos.
 */
describe("tabelas detalhadas — grupos sintéticos em custo fixo/insumos/consumo", () => {
  const groupOf = (i: number) => (i % 2 === 0 ? "Grupo A" : "Grupo B");
  const withGroups = (data: typeof source): typeof source => ({
    ...data,
    fixed: data.fixed.map((f, i) => ({ ...f, groupLabel: groupOf(i) })),
    inputs: data.inputs.map((f, i) => ({ ...f, groupLabel: groupOf(i) })),
    misc: data.misc.map((m, i) => ({ ...m, groupLabel: groupOf(i) })),
  });
  const grouped = computeBridge(withGroups(source), withGroups(target));

  for (const key of ["fixed_cost", "input_price", "usage", "sv_others"]) {
    describe(`tabela ${key}`, () => {
      const table = grouped.tables.find((t) => t.key === key)!;
      const detailRows = table.rows.filter((r) => r.kind === "row");
      const subtotals = table.rows.filter((r) => r.kind === "subtotal");

      it("possui subtotais de grupo", () => {
        expect(subtotals.length).toBeGreaterThan(0);
      });

      it("cada subtotal = soma das linhas-filhas", () => {
        for (const sub of subtotals) {
          const members = detailRows.filter((r) => r.group === sub.group);
          expect(members.length).toBeGreaterThan(0);
          sub.values.forEach((v, j) => {
            if (v == null) return;
            const sum = members.reduce((s, r) => s + (r.values[j] ?? 0), 0);
            expect(v).toBeCloseTo(sum, 9);
          });
        }
      });

      it("Total não muda com a presença dos grupos", () => {
        const baseTable = bridge.tables.find((t) => t.key === key)!;
        const total = table.rows.find((r) => r.kind === "total")!;
        const baseTotal = baseTable.rows.find((r) => r.kind === "total")!;
        total.values.forEach((v, j) => {
          const b = baseTotal.values[j];
          if (v == null || b == null) expect(v).toBe(b);
          else expect(v).toBeCloseTo(b, 9);
        });
      });
    });
  }

  it("os totais das alavancas não mudam com a presença dos grupos", () => {
    for (const [key, value] of Object.entries(bridge.drivers)) {
      expect(grouped.drivers[key]).toBeCloseTo(value, 9);
    }
  });
});
