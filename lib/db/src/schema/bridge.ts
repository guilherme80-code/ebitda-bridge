import {
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A scenario is a combination of version (Budget, MRF7...) and period (FY26...).
export const scenariosTable = pgTable("scenarios", {
  id: text("id").primaryKey(), // e.g. fy26_budget
  version: text("version").notNull(),
  period: text("period").notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

// A bridge explains the variation between a source and a target scenario.
export const bridgesTable = pgTable("bridges", {
  id: serial("id").primaryKey(),
  sourceScenarioId: text("source_scenario_id").notNull(),
  targetScenarioId: text("target_scenario_id").notNull(),
  title: text("title").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
});

// One bar of the EBITDA bridge waterfall (totals and deltas), values in MUSD.
export const bridgeComponentsTable = pgTable("bridge_components", {
  id: serial("id").primaryKey(),
  bridgeId: integer("bridge_id").notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  // "total_start" | "delta" | "total_end"
  kind: text("kind").notNull(),
  valueMusd: doublePrecision("value_musd").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

// Supporting drill-down lines per component, values in MUSD.
export const bridgeDetailLinesTable = pgTable("bridge_detail_lines", {
  id: serial("id").primaryKey(),
  bridgeId: integer("bridge_id").notNull(),
  componentKey: text("component_key").notNull(),
  label: text("label").notNull(),
  group: text("group"),
  valueMusd: doublePrecision("value_musd").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const insertScenarioSchema = createInsertSchema(scenariosTable);
export type InsertScenario = z.infer<typeof insertScenarioSchema>;
export type Scenario = typeof scenariosTable.$inferSelect;

export const insertBridgeSchema = createInsertSchema(bridgesTable).omit({
  id: true,
});
export type InsertBridge = z.infer<typeof insertBridgeSchema>;
export type BridgeRow = typeof bridgesTable.$inferSelect;

export const insertBridgeComponentSchema = createInsertSchema(
  bridgeComponentsTable,
).omit({ id: true });
export type InsertBridgeComponent = z.infer<typeof insertBridgeComponentSchema>;
export type BridgeComponent = typeof bridgeComponentsTable.$inferSelect;

export const insertBridgeDetailLineSchema = createInsertSchema(
  bridgeDetailLinesTable,
).omit({ id: true });
export type InsertBridgeDetailLine = z.infer<
  typeof insertBridgeDetailLineSchema
>;
export type BridgeDetailLine = typeof bridgeDetailLinesTable.$inferSelect;
