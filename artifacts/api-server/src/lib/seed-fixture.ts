/**
 * Loader de cenários a partir do seed real (src/seed/bridge-seed.json),
 * compartilhado pelos testes (bridge-calc.test.ts, simulate.test.ts).
 * Como o seed é o mesmo usado para popular o banco, os testes acompanham
 * automaticamente o formato dos dados de produção.
 */
import type { RawScenarioData } from "./bridge-calc";
import { aggregateMonths } from "./aggregate";
import seed from "../seed/bridge-seed.json";

/**
 * Carrega um cenário derivado (FY/trimestre) consolidando os meses da versão
 * a partir do seed mensal — o mesmo caminho da API (aggregateMonths).
 * Ex.: loadDerived("fy26_fy_budget") soma jan..dez do Budget FY26.
 */
export function loadDerived(id: string): { data: RawScenarioData; monthIds: string[] } {
  const m = id.match(/^fy(\d{2})_(fy|q[1-4])_(.+)$/);
  if (!m) throw new Error(`id derivado inválido: ${id}`);
  const [, yy, per, vSlug] = m;
  const months =
    per === "fy"
      ? Array.from({ length: 12 }, (_, i) => i + 1)
      : Array.from({ length: 3 }, (_, i) => (Number(per[1]) - 1) * 3 + i + 1);
  const monthIds = months.map(
    (mm) => `fy${yy}_m${String(mm).padStart(2, "0")}_${vSlug}`,
  );
  return { data: aggregateMonths(id, monthIds.map(loadScenario)), monthIds };
}

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
      groupLabel: r.group_label == null ? null : String(r.group_label),
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
      groupLabel: r.group_label == null ? null : String(r.group_label),
      amountKusd: num(r.amount_kusd),
      usdDenominated: Boolean(r.usd_denominated),
      sortOrder: num(r.sort_order),
    })),
    inputs: of(seed.input_price_facts as Row[]).map((r) => ({
      scenarioId: id,
      item: String(r.item),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      unitPriceUsd: numOrNull(r.unit_price_usd),
      yieldFactor: numOrNull(r.yield_factor),
      amountKusd: numOrNull(r.amount_kusd),
      sortOrder: num(r.sort_order),
    })),
    misc: of(seed.misc_facts as Row[]).map((r) => ({
      scenarioId: id,
      driver: String(r.driver),
      label: String(r.label),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      amountKusd: num(r.amount_kusd),
      sortOrder: num(r.sort_order),
    })),
  } as RawScenarioData;
}
