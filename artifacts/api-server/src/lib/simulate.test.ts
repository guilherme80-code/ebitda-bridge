/**
 * Testes do fluxo de simulação (rota POST /bridge/simulate, bloco simTables):
 * garantem que as tabelas simuladas sempre trazem os valores originais
 * (`baseValues`) e as flags `changed` alinhados à estrutura do bridge base, e
 * que um caso representativo (volume de Slab Calvert +10% no MRF7) marca
 * exatamente as células esperadas.
 *
 * Os dados vêm do seed real (src/seed/bridge-seed.json), o mesmo usado para
 * popular o banco — assim o teste acompanha automaticamente o formato dos
 * dados de produção.
 */
import { describe, it, expect } from "vitest";
import { computeBridge } from "./bridge-calc";
import {
  simulateBridge,
  buildSimulatedTables,
  buildCatalog,
  type Adjustment,
} from "./simulate";
import { loadScenario } from "./seed-fixture";

const source = loadScenario("fy26_fy_budget"); // FY26 Budget
const target = loadScenario("fy26_fy_mrf7"); // FY26 MRF7
const base = computeBridge(source, target);

function simulate(adjustments: Adjustment[]) {
  return simulateBridge(source, target, adjustments, {
    source: "FY26 Budget",
    target: "FY26 MRF7",
  });
}

describe("buildSimulatedTables — alinhamento com o bridge base", () => {
  const outcome = simulate([
    { scope: "sales_qty", scenario: "target", key: "Slab Calvert", pct: 10 },
  ]);
  const tables = buildSimulatedTables(outcome.bridge, base);

  it("aplica o ajuste (sanidade do cenário de teste)", () => {
    expect(outcome.notFound).toEqual([]);
    expect(outcome.applied).toHaveLength(1);
    expect(outcome.applied[0]).toMatch(/Slab Calvert/);
    expect(outcome.applied[0]).toMatch(/\+10%/);
  });

  it("mantém as mesmas tabelas (chaves, títulos e ordem) do bridge base", () => {
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.map((t) => t.key)).toEqual(base.tables.map((t) => t.key));
    expect(tables.map((t) => t.title)).toEqual(
      base.tables.map((t) => t.title),
    );
  });

  it("mantém o mesmo número de linhas e colunas de cada tabela base", () => {
    for (const table of tables) {
      const baseTable = base.tables.find((t) => t.key === table.key)!;
      expect(table.columns).toEqual(baseTable.columns);
      expect(table.rows.length).toBe(baseTable.rows.length);
      table.rows.forEach((row, i) => {
        expect(row.label).toBe(baseTable.rows[i].label);
        expect(row.kind).toBe(baseTable.rows[i].kind);
        // values, baseValues e changed sempre alinhados às colunas
        expect(row.values.length).toBe(table.columns.length);
        expect(row.baseValues.length).toBe(table.columns.length);
        expect(row.changed.length).toBe(table.columns.length);
      });
    }
  });

  it("baseValues reproduz exatamente os valores do bridge original", () => {
    for (const table of tables) {
      const baseTable = base.tables.find((t) => t.key === table.key)!;
      table.rows.forEach((row, i) => {
        expect(row.baseValues).toEqual(baseTable.rows[i].values);
      });
    }
  });

  it("changed é coerente com values vs baseValues (eps de exibição)", () => {
    for (const table of tables) {
      for (const row of table.rows) {
        row.values.forEach((v, j) => {
          const b = row.baseValues[j];
          const expected =
            v == null && b == null
              ? false
              : v == null || b == null
                ? true
                : Math.abs(v - b) > 0.05;
          expect(row.changed[j]).toBe(expected);
        });
      }
    }
  });
});

describe("caso representativo — volume de Slab Calvert +10% no MRF7", () => {
  const outcome = simulate([
    { scope: "sales_qty", scenario: "target", key: "Slab Calvert", pct: 10 },
  ]);
  const tables = buildSimulatedTables(outcome.bridge, base);
  const sales = tables.find((t) => t.key === "sales")!;
  const col = (key: string) =>
    sales.columns.findIndex((c) => c.key === key);

  it("marca a quantidade destino e Δ qtd do Slab Calvert como alteradas", () => {
    const row = sales.rows.find(
      (r) => r.label === "Slab Calvert" && r.kind === "row",
    )!;
    expect(row).toBeDefined();
    expect(row.changed[col("qty_t")]).toBe(true);
    expect(row.changed[col("qty_var")]).toBe(true);
    expect(row.changed[col("vol_mix")]).toBe(true);
    // qty destino simulada = base × 1,1
    const qtyT = row.values[col("qty_t")]!;
    const qtyTBase = row.baseValues[col("qty_t")]!;
    expect(qtyT / qtyTBase).toBeCloseTo(1.1, 6);
    // colunas de origem e de preço não mudam (montante e qtd escalam juntos)
    expect(row.changed[col("qty_b")]).toBe(false);
    expect(row.changed[col("price_b")]).toBe(false);
    expect(row.changed[col("price_t")]).toBe(false);
  });

  it("não marca a quantidade dos demais produtos", () => {
    for (const row of sales.rows) {
      if (row.kind !== "row" || row.label === "Slab Calvert") continue;
      expect(row.changed[col("qty_b")]).toBe(false);
      expect(row.changed[col("qty_t")]).toBe(false);
      expect(row.changed[col("qty_var")]).toBe(false);
      expect(row.changed[col("price_b")]).toBe(false);
      expect(row.changed[col("price_t")]).toBe(false);
    }
  });

  it("propaga a mudança de quantidade para os subtotais/total de vendas", () => {
    const total = sales.rows.find((r) => r.kind === "total")!;
    expect(total.changed[col("qty_t")]).toBe(true);
    expect(total.changed[col("qty_var")]).toBe(true);
    expect(total.changed[col("qty_b")]).toBe(false);
  });

  it("aumenta o EBITDA simulado do destino (margem positiva do produto)", () => {
    expect(outcome.bridge.end).toBeGreaterThan(base.end);
  });

  it("mantém o plug de Estoque/Outros igual ao do bridge original", () => {
    expect(outcome.bridge.drivers["sv_others"]).toBeCloseTo(
      base.drivers["sv_others"] ?? 0,
      3,
    );
  });
});

describe("simulação — linha ajustada dentro de grupo e pareamento", () => {
  const outcome = simulate([
    { scope: "sales_qty", scenario: "target", key: "Slab Calvert", pct: 10 },
  ]);
  const tables = buildSimulatedTables(outcome.bridge, base);
  const sales = tables.find((t) => t.key === "sales")!;
  const col = (key: string) => sales.columns.findIndex((c) => c.key === key);

  it("a linha ajustada pertence a um grupo e continua presente na tabela", () => {
    const row = sales.rows.find(
      (r) => r.label === "Slab Calvert" && r.kind === "row",
    )!;
    expect(row).toBeDefined();
    expect(row.group).not.toBeNull();
  });

  it("o subtotal do grupo da linha ajustada é marcado como alterado", () => {
    const row = sales.rows.find(
      (r) => r.label === "Slab Calvert" && r.kind === "row",
    )!;
    const subtotal = sales.rows.find(
      (r) => r.kind === "subtotal" && r.group === row.group,
    )!;
    expect(subtotal).toBeDefined();
    expect(subtotal.changed[col("qty_t")]).toBe(true);
    expect(subtotal.changed[col("qty_var")]).toBe(true);
    expect(subtotal.changed[col("qty_b")]).toBe(false);
  });

  it("subtotais de outros grupos não são marcados nas colunas de quantidade", () => {
    const row = sales.rows.find(
      (r) => r.label === "Slab Calvert" && r.kind === "row",
    )!;
    for (const sub of sales.rows.filter((r) => r.kind === "subtotal")) {
      if (sub.group === row.group) continue;
      expect(sub.changed[col("qty_b")]).toBe(false);
      expect(sub.changed[col("qty_t")]).toBe(false);
      expect(sub.changed[col("qty_var")]).toBe(false);
    }
  });

  it("no bridge simulado, subtotal de grupo = soma das linhas-filhas", () => {
    for (const table of tables) {
      const details = table.rows.filter((r) => r.kind === "row");
      for (const sub of table.rows.filter((r) => r.kind === "subtotal")) {
        const members = details.filter((r) => r.group === sub.group);
        expect(members.length).toBeGreaterThan(0);
        sub.values.forEach((v, j) => {
          if (v == null) return;
          const sum = members.reduce((s, r) => s + (r.values[j] ?? 0), 0);
          expect(v).toBeCloseTo(sum, 9);
        });
      }
    }
  });

  it("pareamento por label+kind+índice: baseValues vem da linha base na mesma posição", () => {
    for (const table of tables) {
      const baseTable = base.tables.find((t) => t.key === table.key)!;
      table.rows.forEach((row, i) => {
        const baseRow = baseTable.rows[i];
        // estrutura preservada: mesma posição, mesmo label e kind
        expect(baseRow.label).toBe(row.label);
        expect(baseRow.kind).toBe(row.kind);
        expect(row.baseValues).toEqual(
          row.values.map((_, j) => baseRow.values[j] ?? null),
        );
      });
    }
  });
});

describe("regressões estruturais do contrato simulado", () => {
  it("o catálogo contém o item usado no caso representativo", () => {
    const catalog = buildCatalog(source, target);
    expect(catalog.sales).toContain("Slab Calvert");
  });

  it("ajuste inexistente vai para notFound e não altera nenhuma célula", () => {
    const outcome = simulate([
      {
        scope: "sales_qty",
        scenario: "target",
        key: "Produto Inexistente XYZ",
        pct: 10,
      },
    ]);
    expect(outcome.applied).toEqual([]);
    expect(outcome.notFound).toEqual(["Produto Inexistente XYZ"]);
    const tables = buildSimulatedTables(outcome.bridge, base);
    for (const table of tables) {
      for (const row of table.rows) {
        expect(row.changed.every((c) => c === false)).toBe(true);
      }
    }
  });
});
