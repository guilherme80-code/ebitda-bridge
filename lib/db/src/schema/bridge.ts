import {
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A scenario is a combination of version (Budget, MRF7...) and period (FY26, Q1...).
export const scenariosTable = pgTable("scenarios", {
  id: text("id").primaryKey(), // e.g. fy26_budget
  version: text("version").notNull(),
  period: text("period").notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

/**
 * Fact table mirroring the Databricks model `fato_bridge_detalhe`.
 * ABSOLUTE values per scenario (versao × periodo), at the grain
 * versao × periodo × unidade × driver × item × tipo_registro.
 * The bridge (waterfall) is computed on demand: driver delta =
 * sum(items of target scenario) − sum(items of source scenario).
 */
export const fatoBridgeDetalheTable = pgTable("fato_bridge_detalhe", {
  id: serial("id").primaryKey(),
  versao: text("versao").notNull(), // e.g. BUDGET, MRF7
  periodo: text("periodo").notNull(), // e.g. FY26, Q1, Q2
  unidade: text("unidade").notNull().default("Consolidado"),
  driver: text("driver").notNull(), // e.g. vol_mix, selling_price...
  item: text("item").notNull(), // product / detail line
  // "padrao" (loaded from source systems) | "ajuste" (managerial adjustment)
  tipoRegistro: text("tipo_registro").notNull().default("padrao"),
  valorMusd: doublePrecision("valor_musd").notNull(),
  volumeKt: doublePrecision("volume_kt"),
  precoUsdT: doublePrecision("preco_usd_t"),
  // Only meaningful for tipo_registro = "ajuste":
  justificativa: text("justificativa"),
  responsavel: text("responsavel"),
  status: text("status"), // e.g. aprovado, pendente
  fonte: text("fonte"), // data source (e.g. Excel Cálculo, manual)
});

export const insertScenarioSchema = createInsertSchema(scenariosTable);
export type InsertScenario = z.infer<typeof insertScenarioSchema>;
export type Scenario = typeof scenariosTable.$inferSelect;

export const insertFatoBridgeDetalheSchema = createInsertSchema(
  fatoBridgeDetalheTable,
).omit({ id: true });
export type InsertFatoBridgeDetalhe = z.infer<
  typeof insertFatoBridgeDetalheSchema
>;
export type FatoBridgeDetalhe = typeof fatoBridgeDetalheTable.$inferSelect;

// Canonical driver order / labels for the waterfall (pt-BR).
export const BRIDGE_DRIVERS = [
  { key: "vol_mix", label: "Volume & Mix" },
  { key: "selling_price", label: "Preço de venda" },
  { key: "input_price", label: "Preço de insumos" },
  { key: "usage", label: "Consumo (Usage)" },
  { key: "fixed_cost", label: "Custo fixo" },
  { key: "forex", label: "Câmbio" },
  { key: "sv_others", label: "Estoque / Outros" },
] as const;
