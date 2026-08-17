import {
  db,
  scenariosTable,
  dimItemsTable,
  indicatorFactsTable,
  type InsertDimItem,
  type InsertIndicatorFact,
  type MarketExplanation,
  type MarketExplanationLine,
  type MarketExplanationItem,
  marketIndicatorsTable,
  marketIndicatorLinesTable,
  marketIndicatorValuesTable,
  marketIndicatorItemsTable,
} from "@workspace/db";
import { convertLegacyMarketExplanations, type ConvertedIndicator } from "./market-migrate";
import { convertWideToDimensional } from "./indicator-model";
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

// Tabelas legadas: convertidas na primeira inicialização (quando ainda têm
// dados) e derrubadas em seguida. Os SELECTs abaixo são SQL bruto guardado
// por to_regclass porque as tabelas não existem mais no schema Drizzle — e
// podem nem existir no banco.
const LEGACY_TABLES = [
  "market_explanation_items",
  "market_explanation_lines",
  "market_explanations",
  "misc_facts",
  "input_price_facts",
  "fixed_cost_facts",
  "sales_facts",
  "scenario_params",
] as const;

async function legacyRows(
  executor: Pick<Tx, "execute">,
  table: (typeof LEGACY_TABLES)[number],
): Promise<Row[]> {
  const exists = await executor.execute(
    sql`SELECT to_regclass(${"public." + table}) IS NOT NULL AS present`,
  );
  if (!(exists.rows[0] as { present: boolean }).present) return [];
  const res = await executor.execute(sql.raw(`SELECT * FROM "${table}"`));
  return res.rows as Row[];
}

/**
 * Derruba as tabelas legadas — só é chamada depois que a conversão (quando
 * necessária) terminou com sucesso. Idempotente; roda sob a mesma advisory
 * lock do seed para não competir com outra instância convertendo.
 */
async function dropLegacyTables(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`);
    for (const table of LEGACY_TABLES) {
      await tx.execute(sql.raw(`DROP TABLE IF EXISTS "${table}" CASCADE`));
    }
  });
}

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
  const fromSeed = seedIndicators();

  await db.transaction(async (tx) => {
    // Toda leitura das tabelas legadas acontece DENTRO da advisory lock:
    // fora dela, outra instância poderia derrubá-las entre o to_regclass e o
    // SELECT (corrida de autoscale).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`);
    const check = await tx.select({ id: marketIndicatorsTable.id }).from(marketIndicatorsTable).limit(1);
    if (check.length > 0) return;
    const legacyHeads = (await legacyRows(tx, "market_explanations")).map(
      (r): MarketExplanation => ({
        id: num(r.id),
        sourceId: String(r.source_id),
        targetId: String(r.target_id),
        title: String(r.title),
        unitLabel: String(r.unit_label),
        sortOrder: num(r.sort_order),
      }),
    );
    if (legacyHeads.length === 0 && fromSeed.length === 0) return;
    if (legacyHeads.length > 0) {
      logger.info("Convertendo explicações legadas (pareadas) para o formato por versão");
      const isMonthly = (id: string) => /^fy\d{2}_m\d{2}_/.test(id);
      // Pares mensais carregam os valores originais; pares FY/trimestre são
      // derivados na leitura (soma dos meses) e por isso são redundantes —
      // mas só descartamos quando há pelo menos um par mensal para converter.
      const monthlyHeads = legacyHeads.filter(
        (h) => isMonthly(h.sourceId) && isMonthly(h.targetId),
      );
      if (monthlyHeads.length === 0) {
        throw new Error(
          "Explicações legadas encontradas, mas nenhum par é mensal " +
            "(fyNN_mMM_*): a conversão automática não sabe derivar valores " +
            "mensais de pares FY/trimestre. Reimporte as explicações no " +
            "formato por versão (docs/modelo-indicadores.md) antes de subir " +
            "esta versão. Nada foi alterado.",
        );
      }
      const headIds = new Set(monthlyHeads.map((h) => h.id));
      {
        const legacyLines = (await legacyRows(tx, "market_explanation_lines"))
          .map(
            (r): MarketExplanationLine => ({
              id: num(r.id),
              explanationId: num(r.explanation_id),
              label: String(r.label),
              sourceValue: numOrNull(r.source_value),
              targetValue: numOrNull(r.target_value),
              varValue: numOrNull(r.var_value),
              volumeKt: numOrNull(r.volume_kt),
              impactMusd: num(r.impact_musd),
              sortOrder: num(r.sort_order),
            }),
          )
          .filter((l) => headIds.has(l.explanationId));
        const legacyItems = (await legacyRows(tx, "market_explanation_items"))
          .map(
            (r): MarketExplanationItem => ({
              id: num(r.id),
              explanationId: num(r.explanation_id),
              item: String(r.item),
            }),
          )
          .filter((i) => headIds.has(i.explanationId));
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
    const params = (await legacyRows(tx, "scenario_params")).map((r) => ({
      scenarioId: String(r.scenario_id),
      fxRate: num(r.fx_rate),
      fcFxRate: num(r.fc_fx_rate),
      crudeSteelKt: num(r.crude_steel_kt),
      ebitdaKusd: num(r.ebitda_kusd),
      dmCostShare: num(r.dm_cost_share),
    }));
    const sales = (await legacyRows(tx, "sales_facts")).map((r) => ({
      id: num(r.id),
      scenarioId: String(r.scenario_id),
      productKey: String(r.product_key),
      label: String(r.label),
      currency: String(r.currency),
      domestic: Boolean(r.domestic),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      qtyKt: num(r.qty_kt),
      amountKusd: num(r.amount_kusd),
      varCostKusd: num(r.var_cost_kusd),
      sortOrder: num(r.sort_order),
    }));
    const fixed = (await legacyRows(tx, "fixed_cost_facts")).map((r) => ({
      id: num(r.id),
      scenarioId: String(r.scenario_id),
      category: String(r.category),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      amountKusd: num(r.amount_kusd),
      usdDenominated: Boolean(r.usd_denominated),
      sortOrder: num(r.sort_order),
    }));
    const inputs = (await legacyRows(tx, "input_price_facts")).map((r) => ({
      id: num(r.id),
      scenarioId: String(r.scenario_id),
      item: String(r.item),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      unitPriceUsd: numOrNull(r.unit_price_usd),
      yieldFactor: numOrNull(r.yield_factor),
      amountKusd: numOrNull(r.amount_kusd),
      sortOrder: num(r.sort_order),
    }));
    const misc = (await legacyRows(tx, "misc_facts")).map((r) => ({
      id: num(r.id),
      scenarioId: String(r.scenario_id),
      driver: String(r.driver),
      label: String(r.label),
      groupLabel: r.group_label == null ? null : String(r.group_label),
      amountKusd: num(r.amount_kusd),
      sortOrder: num(r.sort_order),
    }));
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
    // Conversões concluídas (ou nada a converter): as tabelas legadas não
    // são mais necessárias. Se qualquer conversão falhar, nada é derrubado
    // (a exceção interrompe a inicialização antes daqui).
    await dropLegacyTables();
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
  // Bancos recém-publicados podem carregar as tabelas legadas vazias
  // (o publish copia o esquema): derruba depois do seed.
  await dropLegacyTables();

  logger.info("Seed do bridge concluído");
}
