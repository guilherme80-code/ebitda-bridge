import {
  db,
  scenariosTable,
  scenarioParamsTable,
  salesFactsTable,
  fixedCostFactsTable,
  inputPriceFactsTable,
  miscFactsTable,
  dimItemsTable,
  indicatorFactsTable,
  type InsertDimItem,
  type InsertIndicatorFact,
  marketExplanationsTable,
  marketExplanationLinesTable,
  marketExplanationItemsTable,
  marketIndicatorsTable,
  marketIndicatorLinesTable,
  marketIndicatorValuesTable,
  marketIndicatorItemsTable,
} from "@workspace/db";
import { convertLegacyMarketExplanations, type ConvertedIndicator } from "./market-migrate";
import { convertWideToDimensional } from "./indicator-model";
import { inArray, sql } from "drizzle-orm";
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

// Indicadores de explicação (formato por versão): valores por linha × cenário
// mensal. Seções ausentes em seeds antigos são toleradas.
function seedIndicators(): ConvertedIndicator[] {
  const raw = (seed as Record<string, unknown>).market_indicators as Row[] | undefined;
  if (!raw) return [];
  return raw.map((r) => ({
    title: String(r.title),
    unitLabel: String(r.unit_label),
    sortOrder: num(r.sort_order),
    items: (r.items as string[] | undefined) ?? [],
    lines: ((r.lines as Row[] | undefined) ?? []).map((l) => ({
      label: String(l.label),
      kind: (l.kind === "amount" ? "amount" : "price") as "price" | "amount",
      direction: (num(l.direction) >= 0 ? 1 : -1) as 1 | -1,
      sortOrder: num(l.sort_order),
      values: ((l.values as Row[] | undefined) ?? []).map((v) => ({
        scenarioId: String(v.scenario_id),
        value: numOrNull(v.value),
        volumeKt: numOrNull(v.volume_kt),
      })),
    })),
  }));
}

async function insertIndicators(tx: Tx, indicators: ConvertedIndicator[]): Promise<void> {
  for (const ind of indicators) {
    const [head] = await tx
      .insert(marketIndicatorsTable)
      .values({ title: ind.title, unitLabel: ind.unitLabel, sortOrder: ind.sortOrder })
      .returning({ id: marketIndicatorsTable.id });
    for (const line of ind.lines) {
      const [row] = await tx
        .insert(marketIndicatorLinesTable)
        .values({
          indicatorId: head.id,
          label: line.label,
          kind: line.kind,
          direction: line.direction,
          sortOrder: line.sortOrder,
        })
        .returning({ id: marketIndicatorLinesTable.id });
      for (const rows of chunk(line.values)) {
        await tx.insert(marketIndicatorValuesTable).values(
          rows.map((v) => ({
            lineId: row.id,
            scenarioId: v.scenarioId,
            value: v.value,
            volumeKt: v.volumeKt,
          })),
        );
      }
    }
    if (ind.items.length > 0) {
      await tx.insert(marketIndicatorItemsTable).values(
        ind.items.map((item) => ({ indicatorId: head.id, item })),
      );
    }
  }
}

/**
 * Garante os indicadores de explicação no formato por versão:
 *  - tabelas novas com dados → nada a fazer;
 *  - tabelas legadas (pareadas) com dados → converte na própria base,
 *    preservando dados importados pelo usuário;
 *  - senão → semeia do dump bundled (quando presente).
 * Roda sob a mesma trava de concorrência do seed.
 */
async function ensureMarketIndicators(): Promise<void> {
  const existing = await db.select({ id: marketIndicatorsTable.id }).from(marketIndicatorsTable).limit(1);
  if (existing.length > 0) return;
  const legacyHeads = await db.select().from(marketExplanationsTable);
  const fromSeed = seedIndicators();
  if (legacyHeads.length === 0 && fromSeed.length === 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`);
    const check = await tx.select({ id: marketIndicatorsTable.id }).from(marketIndicatorsTable).limit(1);
    if (check.length > 0) return;
    if (legacyHeads.length > 0) {
      logger.info("Convertendo explicações legadas (pareadas) para o formato por versão");
      const isMonthly = (id: string) => /^fy\d{2}_m\d{2}_/.test(id);
      const monthlyHeads = legacyHeads.filter(
        (h) => isMonthly(h.sourceId) && isMonthly(h.targetId),
      );
      const headIds = monthlyHeads.map((h) => h.id);
      if (headIds.length > 0) {
        const [legacyLines, legacyItems] = await Promise.all([
          tx
            .select()
            .from(marketExplanationLinesTable)
            .where(inArray(marketExplanationLinesTable.explanationId, headIds)),
          tx
            .select()
            .from(marketExplanationItemsTable)
            .where(inArray(marketExplanationItemsTable.explanationId, headIds)),
        ]);
        await insertIndicators(
          tx,
          convertLegacyMarketExplanations(monthlyHeads, legacyLines, legacyItems),
        );
        return;
      }
    }
    if (fromSeed.length > 0) {
      logger.info("Backfill dos indicadores de explicação (seed)");
      await insertIndicators(tx, fromSeed);
    }
  });
}

// Seções dimensionais do seed. Seeds antigos (só tabelas largas) são
// convertidos na carga via convertWideToDimensional.
function seedDimensional(): { dims: InsertDimItem[]; facts: InsertIndicatorFact[] } {
  const raw = seed as Record<string, unknown>;
  const dimsRaw = raw.dim_items as Row[] | undefined;
  const factsRaw = raw.indicator_facts as Row[] | undefined;
  if (dimsRaw && factsRaw) {
    return {
      dims: dimsRaw.map((r) => ({
        item: String(r.item),
        secao: String(r.secao),
        moeda: r.moeda == null ? null : String(r.moeda),
        atributo: r.atributo == null ? null : String(r.atributo),
        grupo: r.grupo == null ? null : String(r.grupo),
        sortOrder: num(r.sort_order),
      })),
      facts: factsRaw.map((r) => ({
        scenarioId: String(r.scenario_id),
        item: String(r.item),
        indicador: String(r.indicador),
        valor: num(r.valor),
      })),
    };
  }
  // Seed antigo: converte as seções largas para o modelo dimensional.
  return convertWideToDimensional({
    params: ((raw.scenario_params as Row[]) ?? []).map((r) => ({
      scenarioId: String(r.scenario_id),
      fxRate: num(r.fx_rate),
      fcFxRate: num(r.fc_fx_rate),
      crudeSteelKt: num(r.crude_steel_kt),
      ebitdaKusd: num(r.ebitda_kusd),
      dmCostShare: num(r.dm_cost_share),
    })),
    sales: ((raw.sales_facts as Row[]) ?? []).map((r, i) => ({
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
    fixed: ((raw.fixed_cost_facts as Row[]) ?? []).map((r, i) => ({
      id: i,
      scenarioId: String(r.scenario_id),
      category: String(r.category),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      amountKusd: num(r.amount_kusd),
      usdDenominated: Boolean(r.usd_denominated),
      sortOrder: num(r.sort_order),
    })),
    inputs: ((raw.input_price_facts as Row[]) ?? []).map((r, i) => ({
      id: i,
      scenarioId: String(r.scenario_id),
      item: String(r.item),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      unitPriceUsd: numOrNull(r.unit_price_usd),
      yieldFactor: numOrNull(r.yield_factor),
      amountKusd: numOrNull(r.amount_kusd),
      sortOrder: num(r.sort_order),
    })),
    misc: ((raw.misc_facts as Row[]) ?? []).map((r, i) => ({
      id: i,
      scenarioId: String(r.scenario_id),
      driver: String(r.driver),
      label: String(r.label),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      amountKusd: num(r.amount_kusd),
      sortOrder: num(r.sort_order),
    })),
  });
}

async function insertDimensional(
  tx: Tx,
  d: { dims: InsertDimItem[]; facts: InsertIndicatorFact[] },
): Promise<void> {
  for (const rows of chunk(d.dims)) await tx.insert(dimItemsTable).values(rows);
  for (const rows of chunk(d.facts, 1000)) await tx.insert(indicatorFactsTable).values(rows);
}

/**
 * Upgrade de bancos existentes (ex.: produção já publicada): se o modelo
 * dimensional está vazio mas as tabelas largas têm dados, converte na
 * própria base — preservando o que o usuário importou.
 */
async function ensureDimensionalModel(): Promise<void> {
  const existing = await db.select({ item: dimItemsTable.item }).from(dimItemsTable).limit(1);
  if (existing.length > 0) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`);
    const check = await tx.select({ item: dimItemsTable.item }).from(dimItemsTable).limit(1);
    if (check.length > 0) return;
    const [params, sales, fixed, inputs, misc] = await Promise.all([
      tx.select().from(scenarioParamsTable),
      tx.select().from(salesFactsTable),
      tx.select().from(fixedCostFactsTable),
      tx.select().from(inputPriceFactsTable),
      tx.select().from(miscFactsTable),
    ]);
    if (params.length === 0 && sales.length === 0) return;
    logger.info("Convertendo tabelas largas para o modelo dimensional (dim_items + indicator_facts)");
    await insertDimensional(tx, convertWideToDimensional({ params, sales, fixed, inputs, misc }));
  });
}

/**
 * Garante que as tabelas do modelo dimensional existem antes de qualquer
 * consulta: bancos publicados antes desta versão só têm as tabelas largas
 * (a publicação copia o esquema no momento do publish, não depois). DDL
 * aditiva e idempotente — nunca altera tabelas existentes.
 */
export async function ensureDimensionalSchema(): Promise<void> {
  // Mesma advisory lock transacional do seed: serializa instâncias
  // concorrentes (autoscale) antes de qualquer DDL — `IF NOT EXISTS` não
  // protege contra corrida de catálogo entre dois CREATEs simultâneos.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`);
    await tx.execute(sql`
    CREATE TABLE IF NOT EXISTS "dim_items" (
      "item" text PRIMARY KEY,
      "secao" text NOT NULL,
      "moeda" text,
      "atributo" text,
      "grupo" text,
      "sort_order" integer NOT NULL DEFAULT 0
    )
  `);
    await tx.execute(sql`
    CREATE TABLE IF NOT EXISTS "indicator_facts" (
      "id" serial PRIMARY KEY,
      "scenario_id" text NOT NULL,
      "item" text NOT NULL REFERENCES "dim_items"("item") ON DELETE CASCADE,
      "indicador" text NOT NULL,
      "valor" double precision NOT NULL,
      CONSTRAINT "indicator_facts_scenario_id_item_indicador_unique"
        UNIQUE ("scenario_id", "item", "indicador")
    )
  `);
  });
}

export async function seedIfEmpty(): Promise<void> {
  await ensureDimensionalSchema();
  const existing = await db.select().from(scenariosTable).limit(1);
  if (existing.length > 0) {
    // Banco já semeado por uma versão anterior: garante o modelo dimensional
    // (convertendo as tabelas largas) e os indicadores de explicação no
    // formato por versão. Nunca sobrescreve dados já no formato novo.
    await ensureDimensionalModel();
    await ensureMarketIndicators();
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
    // Fonte canônica: modelo dimensional (as tabelas largas legadas não
    // recebem mais escrita).
    await insertDimensional(tx, seedDimensional());
    await insertIndicators(tx, seedIndicators());
  });

  logger.info("Seed do bridge concluído");
}
