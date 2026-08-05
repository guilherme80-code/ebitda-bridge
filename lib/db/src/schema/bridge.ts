import {
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A scenario is an independent version (BUDGET, MRF1..MRF7) within a period.
// Periods have a granularity kind: "year" (FY25), "quarter" (FY26 Q1) or
// "month" (FY26 Jan). Only scenarios of the same kind can be compared.
export const scenariosTable = pgTable("scenarios", {
  id: text("id").primaryKey(), // e.g. fy26_fy_budget, fy26_q1_mrf3
  version: text("version").notNull(),
  period: text("period").notNull(), // e.g. FY26, FY26 Q1, FY26 Jan
  periodKind: text("period_kind").notNull().default("year"), // year | quarter | month
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

/**
 * Absolute facts per scenario, in MUSD.
 * metric = "ebitda" for the EBITDA level of the version, or a driver key
 * (vol_mix, selling_price, ...) holding the driver's cumulated level relative
 * to the common reference (BUDGET = 0). The bridge between any two scenarios
 * is computed on the fly as target − source per metric.
 * A scenario "has data" when its "ebitda" fact exists.
 */
export const scenarioFactsTable = pgTable("scenario_facts", {
  id: serial("id").primaryKey(),
  scenarioId: text("scenario_id").notNull(),
  metric: text("metric").notNull(),
  valueMusd: doublePrecision("value_musd").notNull(),
});

// Drill-down facts per scenario: cumulated level per driver/line relative to
// the common reference (BUDGET = 0), in MUSD. Missing rows mean level 0.
export const scenarioDetailFactsTable = pgTable("scenario_detail_facts", {
  id: serial("id").primaryKey(),
  scenarioId: text("scenario_id").notNull(),
  componentKey: text("component_key").notNull(),
  label: text("label").notNull(),
  group: text("group"),
  valueMusd: doublePrecision("value_musd").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

// Waterfall driver catalog (order and Portuguese labels).
export const BRIDGE_DRIVERS = [
  { key: "vol_mix", label: "Volume & Mix" },
  { key: "selling_price", label: "Preço de venda" },
  { key: "input_price", label: "Preço de insumos" },
  { key: "usage", label: "Consumo (Usage)" },
  { key: "fixed_cost", label: "Custo fixo" },
  { key: "forex", label: "Câmbio" },
  { key: "sv_others", label: "Estoque / Outros" },
] as const;

export const insertScenarioSchema = createInsertSchema(scenariosTable);
export type InsertScenario = z.infer<typeof insertScenarioSchema>;
export type Scenario = typeof scenariosTable.$inferSelect;

export const insertScenarioFactSchema = createInsertSchema(
  scenarioFactsTable,
).omit({ id: true });
export type InsertScenarioFact = z.infer<typeof insertScenarioFactSchema>;
export type ScenarioFact = typeof scenarioFactsTable.$inferSelect;

export const insertScenarioDetailFactSchema = createInsertSchema(
  scenarioDetailFactsTable,
).omit({ id: true });
export type InsertScenarioDetailFact = z.infer<
  typeof insertScenarioDetailFactSchema
>;
export type ScenarioDetailFact = typeof scenarioDetailFactsTable.$inferSelect;
