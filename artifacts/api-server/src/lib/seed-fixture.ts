/**
 * Loader de cenários a partir do seed real (src/seed/bridge-seed.json),
 * compartilhado pelos testes (bridge-calc.test.ts, simulate.test.ts).
 * Como o seed é o mesmo usado para popular o banco, os testes acompanham
 * automaticamente o formato dos dados de produção.
 */
import type { RawScenarioData } from "./bridge-calc";
import seed from "../seed/bridge-seed.json";

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/** Monta RawScenarioData a partir do seed (colunas snake_case do export). */
export function loadScenario(id: string): RawScenarioData {
  const p = (seed.scenario_params as Row[]).find(
    (r) => r.scenario_id === id,
  );
  if (!p) throw new Error(`cenário ${id} ausente no seed`);
  const of = <T extends Row>(rows: Row[]): T[] =>
    rows.filter((r) => r.scenario_id === id) as T[];
  return {
    params: {
      scenarioId: id,
      fxRate: num(p.fx_rate),
      fcFxRate: num(p.fc_fx_rate),
      crudeSteelKt: num(p.crude_steel_kt),
      ebitdaKusd: num(p.ebitda_kusd),
      dmCostShare: num(p.dm_cost_share),
    },
    sales: of(seed.sales_facts as Row[]).map((r) => ({
      scenarioId: id,
      productKey: String(r.product_key),
      label: String(r.label),
      currency: String(r.currency),
      domestic: Boolean(r.domestic),
      qtyKt: num(r.qty_kt),
      amountKusd: num(r.amount_kusd),
      varCostKusd: num(r.var_cost_kusd),
      sortOrder: num(r.sort_order),
    })),
    fixed: of(seed.fixed_cost_facts as Row[]).map((r) => ({
      scenarioId: id,
      category: String(r.category),
      amountKusd: num(r.amount_kusd),
      usdDenominated: Boolean(r.usd_denominated),
      sortOrder: num(r.sort_order),
    })),
    inputs: of(seed.input_price_facts as Row[]).map((r) => ({
      scenarioId: id,
      item: String(r.item),
      unitPriceUsd: numOrNull(r.unit_price_usd),
      yieldFactor: numOrNull(r.yield_factor),
      amountKusd: numOrNull(r.amount_kusd),
      sortOrder: num(r.sort_order),
    })),
    misc: of(seed.misc_facts as Row[]).map((r) => ({
      scenarioId: id,
      driver: String(r.driver),
      label: String(r.label),
      amountKusd: num(r.amount_kusd),
      sortOrder: num(r.sort_order),
    })),
  } as RawScenarioData;
}
