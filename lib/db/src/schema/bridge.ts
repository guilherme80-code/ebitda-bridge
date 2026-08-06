import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A scenario is an independent version (BUDGET, MRF1..MRF7) within a period.
// Periods have a granularity kind: "year" (FY26), "quarter" (Q126) or
// "month" (JAN26). Only scenarios of the same kind can be compared.
export const scenariosTable = pgTable("scenarios", {
  id: text("id").primaryKey(), // e.g. fy26_fy_budget, fy26_q1_mrf3
  version: text("version").notNull(),
  period: text("period").notNull(), // e.g. FY26, Q126, JAN26
  periodKind: text("period_kind").notNull().default("year"), // year | quarter | month
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

/**
 * Raw data model (mirrors the "Cálculo" sheet of Modelo Bridge.xlsx).
 * Scenarios store only raw inputs — quantity and amount per version/period.
 * All performance effects (price, volume, mix, forex, fixed cost, input
 * price, usage, others, stock variation) are computed at comparison time
 * from the raw facts of the selected source/target pair.
 */

// Scenario-level parameters ("Cálculo" rows 125/144/150-152):
// fx rate (BRL/USD), crude steel production, EBITDA (from DRE) and the
// domestic share of EBITDA cost used by the forex driver.
export const scenarioParamsTable = pgTable("scenario_params", {
  scenarioId: text("scenario_id").primaryKey(),
  fxRate: doublePrecision("fx_rate").notNull(),
  // Câmbio específico do bloco de custo fixo (E125/H125 na aba Cálculo);
  // pode diferir ligeiramente do câmbio geral (E152/H152).
  fcFxRate: doublePrecision("fc_fx_rate").notNull().default(0),
  crudeSteelKt: doublePrecision("crude_steel_kt").notNull(),
  ebitdaKusd: doublePrecision("ebitda_kusd").notNull(),
  dmCostShare: doublePrecision("dm_cost_share").notNull().default(0.4),
});

// Sales + variable cost per product ("Cálculo" rows 17-47 and 50-80).
// currency = "BRL" for domestic-market products (price effect computed in
// local currency; difference vs USD goes to the forex driver), "USD" for
// export/intragroup products. domestic = true when the product's revenue is
// exposed to forex (rows included in H150).
export const salesFactsTable = pgTable("sales_facts", {
  id: serial("id").primaryKey(),
  scenarioId: text("scenario_id").notNull(),
  productKey: text("product_key").notNull(),
  label: text("label").notNull(),
  currency: text("currency").notNull(), // BRL | USD
  domestic: boolean("domestic").notNull().default(false),
  groupLabel: text("group_label"),
  qtyKt: doublePrecision("qty_kt").notNull(),
  amountKusd: doublePrecision("amount_kusd").notNull(),
  varCostKusd: doublePrecision("var_cost_kusd").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

// Fixed cost per category ("Cálculo" rows 116-124). usdDenominated = true for
// the "... USD" categories, which have no forex split.
export const fixedCostFactsTable = pgTable("fixed_cost_facts", {
  id: serial("id").primaryKey(),
  scenarioId: text("scenario_id").notNull(),
  category: text("category").notNull(),
  groupLabel: text("group_label"),
  amountKusd: doublePrecision("amount_kusd").notNull(),
  usdDenominated: boolean("usd_denominated").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

// Input price items ("Cálculo" rows 128-144). Two shapes:
//  - priced items: unitPriceUsd + yieldFactor (effect = Δprice × yield × crude
//    steel production of the target scenario)
//  - direct items (Alloys, Zinc, Natural Gas...): amountKusd holds the level
//    of the item relative to the reference; effect = target − source.
export const inputPriceFactsTable = pgTable("input_price_facts", {
  id: serial("id").primaryKey(),
  scenarioId: text("scenario_id").notNull(),
  item: text("item").notNull(),
  groupLabel: text("group_label"),
  unitPriceUsd: doublePrecision("unit_price_usd"),
  yieldFactor: doublePrecision("yield_factor"),
  amountKusd: doublePrecision("amount_kusd"),
  sortOrder: integer("sort_order").notNull().default(0),
});

// Usage / Others / Stock-variation line items ("Cálculo" rows 147, 155-181).
// amountKusd is the level of the item in the scenario; the driver effect of a
// comparison is target − source per line. driver = usage | others | stock_variation.
export const miscFactsTable = pgTable("misc_facts", {
  id: serial("id").primaryKey(),
  scenarioId: text("scenario_id").notNull(),
  driver: text("driver").notNull(),
  label: text("label").notNull(),
  groupLabel: text("group_label"),
  amountKusd: doublePrecision("amount_kusd").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

// Waterfall driver catalog (order and Portuguese labels).
export const BRIDGE_DRIVERS = [
  { key: "vol_mix", label: "Volume & Mix" },
  { key: "selling_price", label: "Preço de venda" },
  { key: "input_price", label: "Preço de insumos" },
  { key: "usage", label: "Consumo (Usage)" },
  { key: "fixed_cost", label: "Custo fixo" },
  { key: "forex", label: "Câmbio" },
  // Barra única combinando Variação de estoque e Outros; o detalhamento
  // (drill-down) mostra os dois grupos separados.
  { key: "sv_others", label: "Estoque / Outros" },
] as const;

export const insertScenarioSchema = createInsertSchema(scenariosTable);
export type InsertScenario = z.infer<typeof insertScenarioSchema>;
export type Scenario = typeof scenariosTable.$inferSelect;

export const insertScenarioParamsSchema =
  createInsertSchema(scenarioParamsTable);
export type InsertScenarioParams = z.infer<typeof insertScenarioParamsSchema>;
export type ScenarioParams = typeof scenarioParamsTable.$inferSelect;

export const insertSalesFactSchema = createInsertSchema(salesFactsTable).omit({
  id: true,
});
export type InsertSalesFact = z.infer<typeof insertSalesFactSchema>;
export type SalesFact = typeof salesFactsTable.$inferSelect;

export const insertFixedCostFactSchema = createInsertSchema(
  fixedCostFactsTable,
).omit({ id: true });
export type InsertFixedCostFact = z.infer<typeof insertFixedCostFactSchema>;
export type FixedCostFact = typeof fixedCostFactsTable.$inferSelect;

export const insertInputPriceFactSchema = createInsertSchema(
  inputPriceFactsTable,
).omit({ id: true });
export type InsertInputPriceFact = z.infer<typeof insertInputPriceFactSchema>;
export type InputPriceFact = typeof inputPriceFactsTable.$inferSelect;

export const insertMiscFactSchema = createInsertSchema(miscFactsTable).omit({
  id: true,
});
export type InsertMiscFact = z.infer<typeof insertMiscFactSchema>;
export type MiscFact = typeof miscFactsTable.$inferSelect;

// User-entered explanations of the EBITDA variation between a source and
// target scenario. One pair can have many explanations; they are kept for
// anyone who consults the pair in the future.
export const bridgeExplanationsTable = pgTable("bridge_explanations", {
  id: serial("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  targetId: text("target_id").notNull(),
  valueMusd: doublePrecision("value_musd").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Market explanations: reference tables (e.g. Iron Ores) imported from a
// separate source, scoped to a source/target scenario pair. Each explanation
// has detail lines (price source/target, variation, volume, $m impact) and a
// list of impacted bridge items (e.g. Fines, Pellets, Lumps) that open the
// explanation pop-up when clicked.
export const marketExplanationsTable = pgTable("market_explanations", {
  id: serial("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  targetId: text("target_id").notNull(),
  title: text("title").notNull(), // e.g. "Iron Ores"
  unitLabel: text("unit_label").notNull().default("Price $/t"),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const marketExplanationLinesTable = pgTable("market_explanation_lines", {
  id: serial("id").primaryKey(),
  explanationId: integer("explanation_id")
    .notNull()
    .references(() => marketExplanationsTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  sourceValue: doublePrecision("source_value"),
  targetValue: doublePrecision("target_value"),
  varValue: doublePrecision("var_value"),
  volumeKt: doublePrecision("volume_kt"),
  impactMusd: doublePrecision("impact_musd").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const marketExplanationItemsTable = pgTable("market_explanation_items", {
  id: serial("id").primaryKey(),
  explanationId: integer("explanation_id")
    .notNull()
    .references(() => marketExplanationsTable.id, { onDelete: "cascade" }),
  item: text("item").notNull(), // label of the impacted bridge item
});

export const insertMarketExplanationSchema = createInsertSchema(
  marketExplanationsTable,
).omit({ id: true });
export type InsertMarketExplanation = z.infer<typeof insertMarketExplanationSchema>;
export type MarketExplanation = typeof marketExplanationsTable.$inferSelect;

export const insertMarketExplanationLineSchema = createInsertSchema(
  marketExplanationLinesTable,
).omit({ id: true });
export type InsertMarketExplanationLine = z.infer<
  typeof insertMarketExplanationLineSchema
>;
export type MarketExplanationLine =
  typeof marketExplanationLinesTable.$inferSelect;

export const insertMarketExplanationItemSchema = createInsertSchema(
  marketExplanationItemsTable,
).omit({ id: true });
export type InsertMarketExplanationItem = z.infer<
  typeof insertMarketExplanationItemSchema
>;
export type MarketExplanationItem =
  typeof marketExplanationItemsTable.$inferSelect;

export const insertBridgeExplanationSchema = createInsertSchema(
  bridgeExplanationsTable,
).omit({ id: true, createdAt: true });
export type InsertBridgeExplanation = z.infer<
  typeof insertBridgeExplanationSchema
>;
export type BridgeExplanation = typeof bridgeExplanationsTable.$inferSelect;
