import {
  db,
  scenariosTable,
  scenarioParamsTable,
  salesFactsTable,
  fixedCostFactsTable,
  inputPriceFactsTable,
  miscFactsTable,
  marketExplanationsTable,
  marketExplanationLinesTable,
  marketExplanationItemsTable,
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Explicações de mercado (seções ausentes em seeds antigos são toleradas).
// Os ids são preservados do dump para manter os vínculos linha/item.
async function seedMarketExplanations(tx: Tx): Promise<void> {
  for (const rows of chunk((seed as Record<string, unknown>).market_explanations as Row[] | undefined ?? [])) {
    await tx.insert(marketExplanationsTable).values(
      rows.map((r) => ({
        id: num(r.id),
        sourceId: String(r.source_id),
        targetId: String(r.target_id),
        title: String(r.title),
        unitLabel: String(r.unit_label),
        sortOrder: num(r.sort_order),
      })),
    );
  }
  for (const rows of chunk((seed as Record<string, unknown>).market_explanation_lines as Row[] | undefined ?? [])) {
    await tx.insert(marketExplanationLinesTable).values(
      rows.map((r) => ({
        explanationId: num(r.explanation_id),
        label: String(r.label),
        sourceValue: numOrNull(r.source_value),
        targetValue: numOrNull(r.target_value),
        varValue: numOrNull(r.var_value),
        volumeKt: numOrNull(r.volume_kt),
        impactMusd: num(r.impact_musd),
        sortOrder: num(r.sort_order),
      })),
    );
  }
  for (const rows of chunk((seed as Record<string, unknown>).market_explanation_items as Row[] | undefined ?? [])) {
    await tx.insert(marketExplanationItemsTable).values(
      rows.map((r) => ({
        explanationId: num(r.explanation_id),
        item: String(r.item),
      })),
    );
  }
  // Reserva os ids já usados pelo dump na sequência da tabela.
  await tx.execute(sql`
    SELECT setval(
      pg_get_serial_sequence('market_explanations', 'id'),
      (SELECT COALESCE(MAX(id), 0) + 1 FROM market_explanations),
      false
    )
  `);
}

export async function seedIfEmpty(): Promise<void> {
  const existing = await db.select().from(scenariosTable).limit(1);
  if (existing.length > 0) {
    // Banco já semeado por uma versão anterior: garante o backfill das
    // explicações (tabelas novas ficam vazias após o upgrade de schema) e a
    // migração do formato antigo (explicações guardadas por par FY/trimestre)
    // para o formato mensal — o painel só lê pares mensais agora. Nunca
    // sobrescreve dados já importados no formato mensal.
    const marketHeads = await db
      .select({ sourceId: marketExplanationsTable.sourceId })
      .from(marketExplanationsTable);
    const isMonthly = (id: string) => /^fy\d{2}_m\d{2}_/.test(id);
    const onlyLegacy =
      marketHeads.length > 0 && marketHeads.every((h) => !isMonthly(h.sourceId));
    const seedHasMarket =
      (((seed as Record<string, unknown>).market_explanations as Row[] | undefined) ?? []).length > 0;
    if ((marketHeads.length === 0 || onlyLegacy) && seedHasMarket) {
      logger.info(
        marketHeads.length === 0
          ? "Backfill das explicações (seed)"
          : "Migrando explicações do formato por período para o mensal (seed)",
      );
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`);
        const check = await tx
          .select({ sourceId: marketExplanationsTable.sourceId })
          .from(marketExplanationsTable);
        if (check.some((h) => isMonthly(h.sourceId))) return;
        await tx.delete(marketExplanationItemsTable);
        await tx.delete(marketExplanationLinesTable);
        await tx.delete(marketExplanationsTable);
        await seedMarketExplanations(tx);
      });
    }
    return;
  }

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
    await seedMarketExplanations(tx);
  });

  logger.info("Seed do bridge concluído");
}
