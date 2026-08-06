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
import { loadScenario, loadDerived } from "./seed-fixture";

// FY é derivado: soma dos 12 meses da versão (fonte mensal).
const { data: source, monthIds: sourceMonths } = loadDerived("fy26_fy_budget");
const { data: target, monthIds: targetMonths } = loadDerived("fy26_fy_mrf7");
const bridge = computeBridge(source, target);

const DRIVER_KEYS = [
  "vol_mix",
  "selling_price",
  "input_price",
  "usage",
  "fixed_cost",
  "forex",
  "stock",
  "sv_others",
];

describe("computeBridge — FY26 Budget → FY26 MRF7 (FY consolidado dos meses)", () => {
  const K = 1000;
  const monthlyEbitda = (ids: string[]) =>
    ids.reduce((s, id) => s + loadScenario(id).params.ebitdaKusd, 0) / K;

  it("start (EBITDA origem) = soma dos 12 meses do Budget", () => {
    expect(bridge.start).toBeCloseTo(monthlyEbitda(sourceMonths), 6);
  });

  it("end (EBITDA destino) = soma dos 12 meses do MRF7", () => {
    expect(bridge.end).toBeCloseTo(monthlyEbitda(targetMonths), 6);
  });

  it("tem exatamente as alavancas esperadas", () => {
    expect(Object.keys(bridge.drivers).sort()).toEqual([...DRIVER_KEYS].sort());
  });

  // Regressão numérica: valores conferidos após a virada para fonte mensal
  // (coincidem com a antiga referência do Excel, já que os meses somam o FY).
  const EXPECTED_DRIVERS: Record<string, number> = {
    vol_mix: -6.680380721635167,
    selling_price: 286.54894369344686,
    input_price: -177.47194678166514,
    usage: -12.829343372386798,
    fixed_cost: -34.29055851516902,
    forex: 70.57285860656927,
    // O seed traz Stock Variation: "Estoque" recebe o valor real dos dados e
    // "Outros" (sv_others) fica só com a diferença de fechamento restante.
    // A soma dos dois é o antigo plug único (-10.20121656225709).
    stock: -3.860422459599194,
    sv_others: -6.340794102657895,
  };

  it("Estoque + Outros = antigo plug único (Estoque / Outros)", () => {
    expect(
      (bridge.drivers["stock"] ?? 0) + (bridge.drivers["sv_others"] ?? 0),
    ).toBeCloseTo(-10.20121656225709, 6);
  });

  it("Estoque bate com a diferença das linhas de Stock Variation dos dados", () => {
    const sumStock = (d: typeof source) =>
      d.misc
        .filter((m) => m.driver === "stock_variation")
        .reduce((s, m) => s + m.amountKusd, 0);
    expect(bridge.drivers["stock"]).toBeCloseTo(
      (sumStock(target) - sumStock(source)) / 1000,
      9,
    );
  });

  it("sem Stock Variation nos dados, volta ao plug único sv_others", () => {
    const strip = (d: typeof source) => ({
      ...d,
      misc: d.misc.filter((m) => m.driver !== "stock_variation"),
    });
    const b = computeBridge(strip(source), strip(target));
    expect(Object.keys(b.drivers)).not.toContain("stock");
    // O plug absorve o que antes era explicado pelas linhas de estoque.
    expect(b.drivers["sv_others"]).toBeCloseTo(-10.20121656225709, 6);
    const sum = Object.values(b.drivers).reduce((s, v) => s + v, 0);
    expect(b.start + sum).toBeCloseTo(b.end, 9);
  });
  for (const [key, value] of Object.entries(EXPECTED_DRIVERS)) {
    it(`alavanca ${key} bate com a referência`, () => {
      expect(bridge.drivers[key]).toBeCloseTo(value, 6);
    });
  }

  it("o bridge fecha: start + soma das alavancas = end", () => {
    const sum = Object.values(bridge.drivers).reduce((s, v) => s + v, 0);
    expect(bridge.start + sum).toBeCloseTo(bridge.end, 9);
  });

  it("quantidades consolidadas = soma das quantidades mensais (por produto)", () => {
    const monthly = new Map<string, number>();
    for (const id of sourceMonths) {
      for (const s of loadScenario(id).sales) {
        monthly.set(s.productKey, (monthly.get(s.productKey) ?? 0) + s.qtyKt);
      }
    }
    for (const s of source.sales) {
      expect(s.qtyKt).toBeCloseTo(monthly.get(s.productKey) ?? 0, 9);
    }
  });

  it("trimestres também fecham (Q1 Budget → Q1 MRF7)", () => {
    const q = computeBridge(
      loadDerived("fy26_q1_budget").data,
      loadDerived("fy26_q1_mrf7").data,
    );
    const sum = Object.values(q.drivers).reduce((s, v) => s + v, 0);
    expect(q.start + sum).toBeCloseTo(q.end, 9);
  });

  it("mês contra mês também fecha (JAN Budget → JAN MRF7)", () => {
    const m = computeBridge(
      loadScenario("fy26_m01_budget"),
      loadScenario("fy26_m01_mrf7"),
    );
    const sum = Object.values(m.drivers).reduce((s, v) => s + v, 0);
    expect(m.start + sum).toBeCloseTo(m.end, 9);
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
