/**
 * Ida e volta do modelo dimensional: as tabelas largas do seed real são
 * convertidas para dim_items + indicator_facts (convertWideToDimensional)
 * e reconstruídas (buildRawScenarios) — o resultado deve ser idêntico ao
 * formato largo original, cenário a cenário.
 */
import { describe, it, expect } from "vitest";
import { buildRawScenarios, convertWideToDimensional } from "./indicator-model";
import { loadScenario } from "./seed-fixture";
import seed from "../seed/bridge-seed.json";

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

function wideFromSeed() {
  const s = seed as Record<string, unknown>;
  return {
    params: ((s.scenario_params as Row[]) ?? []).map((r) => ({
      scenarioId: String(r.scenario_id),
      fxRate: num(r.fx_rate),
      fcFxRate: num(r.fc_fx_rate),
      crudeSteelKt: num(r.crude_steel_kt),
      ebitdaKusd: num(r.ebitda_kusd),
      dmCostShare: num(r.dm_cost_share),
    })),
    sales: ((s.sales_facts as Row[]) ?? []).map((r, i) => ({
      id: i,
      scenarioId: String(r.scenario_id),
      productKey: String(r.product_key),
      label: String(r.label),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      currency: String(r.currency),
      domestic: Boolean(r.domestic),
      qtyKt: num(r.qty_kt),
      amountKusd: num(r.amount_kusd),
      varCostKusd: num(r.var_cost_kusd),
      sortOrder: num(r.sort_order),
    })),
    fixed: ((s.fixed_cost_facts as Row[]) ?? []).map((r, i) => ({
      id: i,
      scenarioId: String(r.scenario_id),
      category: String(r.category),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      amountKusd: num(r.amount_kusd),
      usdDenominated: Boolean(r.usd_denominated),
      sortOrder: num(r.sort_order),
    })),
    inputs: ((s.input_price_facts as Row[]) ?? []).map((r, i) => ({
      id: i,
      scenarioId: String(r.scenario_id),
      item: String(r.item),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      unitPriceUsd: numOrNull(r.unit_price_usd),
      yieldFactor: numOrNull(r.yield_factor),
      amountKusd: numOrNull(r.amount_kusd),
      sortOrder: num(r.sort_order),
    })),
    misc: ((s.misc_facts as Row[]) ?? []).map((r, i) => ({
      id: i,
      scenarioId: String(r.scenario_id),
      driver: String(r.driver),
      label: String(r.label),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      amountKusd: num(r.amount_kusd),
      sortOrder: num(r.sort_order),
    })),
  };
}

describe("modelo dimensional — ida e volta com o seed real", () => {
  it("convertWideToDimensional + buildRawScenarios reproduz o formato largo", () => {
    const wide = wideFromSeed();
    const { dims, facts } = convertWideToDimensional(wide);
    expect(dims.length).toBeGreaterThan(0);
    expect(facts.length).toBeGreaterThan(0);

    const raw = buildRawScenarios(
      dims.map((d, i) => ({
        item: d.item,
        secao: d.secao,
        moeda: d.moeda ?? null,
        atributo: d.atributo ?? null,
        grupo: d.grupo ?? null,
        sortOrder: d.sortOrder ?? i,
      })),
      facts,
    );
    const ids = wide.params.map((p) => p.scenarioId);
    expect(new Set(raw.keys())).toEqual(new Set(ids));

    // A reconstrução usa o sortOrder GLOBAL da dimensão (a ordem relativa é a
    // mesma); id e sortOrder absolutos não fazem parte do contrato de leitura.
    const norm = (rows: Record<string, unknown>[]) =>
      [...rows]
        .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0))
        .map(({ id: _id, sortOrder: _s, ...rest }) => rest);
    const strip = (d: ReturnType<typeof loadScenario>) => ({
      params: d.params,
      sales: norm(d.sales as unknown as Record<string, unknown>[]),
      fixed: norm(d.fixed as unknown as Record<string, unknown>[]),
      inputs: norm(d.inputs as unknown as Record<string, unknown>[]),
      misc: norm(d.misc as unknown as Record<string, unknown>[]),
    });
    for (const id of ids) {
      const rebuilt = raw.get(id)!;
      expect(strip(rebuilt)).toEqual(strip(loadScenario(id)));
    }
  });

  it("dim_items do seed bate com a conversão das tabelas largas", () => {
    const { dims } = convertWideToDimensional(wideFromSeed());
    const seedDims = (seed as Record<string, unknown>).dim_items as Row[];
    expect(seedDims).toBeDefined();
    expect(seedDims.length).toBe(dims.length);
    const byItem = new Map(dims.map((d) => [d.item, d]));
    for (const r of seedDims) {
      const d = byItem.get(String(r.item));
      expect(d, `item ${String(r.item)} ausente na conversão`).toBeDefined();
      expect({
        secao: d!.secao,
        moeda: d!.moeda ?? null,
        atributo: d!.atributo ?? null,
        grupo: d!.grupo ?? null,
      }).toEqual({
        secao: r.secao,
        moeda: r.moeda ?? null,
        atributo: r.atributo ?? null,
        grupo: r.grupo ?? null,
      });
    }
  });
});
