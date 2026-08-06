import {
  db,
  scenariosTable,
  scenarioParamsTable,
  salesFactsTable,
  fixedCostFactsTable,
  inputPriceFactsTable,
  miscFactsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import seed from "../seed/bridge-seed.json";
import { logger } from "./logger";

type Row = Record<string, unknown>;

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

function chunk<T>(rows: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Seeds the bridge dataset (exported from the development database) when the
 * database is empty — e.g. on the first production boot after publishing,
 * since publishing copies the schema but not the data.
 */
const SEED_LOCK_KEY = 764_211_003; // arbitrary app-wide advisory lock id

export async function seedIfEmpty(): Promise<void> {
  const existing = await db.select().from(scenariosTable).limit(1);
  if (existing.length > 0) return;

  logger.info("Banco vazio — importando dados do bridge (seed)");

  await db.transaction(async (tx) => {
    // Serialize concurrent cold starts (autoscale can boot several
    // instances at once); the lock is released at commit/rollback.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`);
    // Re-check after acquiring the lock: another instance may have
    // just finished seeding while we waited.
    const check = await tx.select().from(scenariosTable).limit(1);
    if (check.length > 0) return;
    for (const rows of chunk(seed.scenarios as Row[])) {
      await tx.insert(scenariosTable).values(
        rows.map((r) => ({
          id: String(r.id),
          version: String(r.version),
          period: String(r.period),
          periodKind: String(r.period_kind),
          label: String(r.label),
          sortOrder: num(r.sort_order),
        })),
      );
    }
    for (const rows of chunk(seed.scenario_params as Row[])) {
      await tx.insert(scenarioParamsTable).values(
        rows.map((r) => ({
          scenarioId: String(r.scenario_id),
          fxRate: num(r.fx_rate),
          fcFxRate: num(r.fc_fx_rate),
          crudeSteelKt: num(r.crude_steel_kt),
          ebitdaKusd: num(r.ebitda_kusd),
          dmCostShare: num(r.dm_cost_share),
        })),
      );
    }
    for (const rows of chunk(seed.sales_facts as Row[])) {
      await tx.insert(salesFactsTable).values(
        rows.map((r) => ({
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
      );
    }
    for (const rows of chunk(seed.fixed_cost_facts as Row[])) {
      await tx.insert(fixedCostFactsTable).values(
        rows.map((r) => ({
          scenarioId: String(r.scenario_id),
          category: String(r.category),
          groupLabel: r.group_label == null ? null : String(r.group_label),
          amountKusd: num(r.amount_kusd),
          usdDenominated: Boolean(r.usd_denominated),
          sortOrder: num(r.sort_order),
        })),
      );
    }
    for (const rows of chunk(seed.input_price_facts as Row[])) {
      await tx.insert(inputPriceFactsTable).values(
        rows.map((r) => ({
          scenarioId: String(r.scenario_id),
          item: String(r.item),
          groupLabel: r.group_label == null ? null : String(r.group_label),
          unitPriceUsd: numOrNull(r.unit_price_usd),
          yieldFactor: numOrNull(r.yield_factor),
          amountKusd: numOrNull(r.amount_kusd),
          sortOrder: num(r.sort_order),
        })),
      );
    }
    for (const rows of chunk(seed.misc_facts as Row[])) {
      await tx.insert(miscFactsTable).values(
        rows.map((r) => ({
          scenarioId: String(r.scenario_id),
          driver: String(r.driver),
          label: String(r.label),
          groupLabel: r.group_label == null ? null : String(r.group_label),
          amountKusd: num(r.amount_kusd),
          sortOrder: num(r.sort_order),
        })),
      );
    }
  });

  logger.info("Seed do bridge concluído");
}
