import {
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A scenario is an independent version (BUDGET, MRF1..MRF12) within a period.
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
 * Formas "largas" em memória (espelham a aba "Cálculo" do Modelo Bridge.xlsx).
 * As tabelas físicas correspondentes (scenario_params, sales_facts,
 * fixed_cost_facts, input_price_facts, misc_facts) foram REMOVIDAS do banco:
 * o seed converte bancos antigos na primeira inicialização e depois as
 * derruba (DROP). Estes tipos permanecem porque o cálculo do bridge e os
 * importadores continuam trabalhando com as formas largas em memória — o
 * painel as reconstrói na leitura a partir de dim_items + indicator_facts.
 */

// Parâmetros por cenário ("Cálculo" linhas 125/144/150-152).
export type ScenarioParams = {
  scenarioId: string;
  fxRate: number;
  // Câmbio específico do bloco de custo fixo (E125/H125 na aba Cálculo);
  // pode diferir ligeiramente do câmbio geral (E152/H152).
  fcFxRate: number;
  crudeSteelKt: number;
  ebitdaKusd: number;
  dmCostShare: number;
};
export type InsertScenarioParams = Omit<ScenarioParams, "fcFxRate" | "dmCostShare"> & {
  fcFxRate?: number;
  dmCostShare?: number;
};

// Vendas + custo variável por produto ("Cálculo" linhas 17-47 e 50-80).
// currency = "BRL" para mercado interno (efeito preço em moeda local;
// diferença vs USD vai para o driver de câmbio), "USD" para exportação/
// intragrupo. domestic = true quando a receita é exposta ao câmbio.
export type SalesFact = {
  id: number;
  scenarioId: string;
  productKey: string;
  label: string;
  currency: string; // BRL | USD
  domestic: boolean;
  groupLabel: string | null;
  qtyKt: number;
  amountKusd: number;
  varCostKusd: number;
  sortOrder: number;
};
export type InsertSalesFact = Omit<SalesFact, "id" | "domestic" | "groupLabel" | "sortOrder"> & {
  domestic?: boolean;
  groupLabel?: string | null;
  sortOrder?: number;
};

// Custo fixo por categoria ("Cálculo" linhas 116-124). usdDenominated = true
// para as categorias "... USD", sem abertura de câmbio.
export type FixedCostFact = {
  id: number;
  scenarioId: string;
  category: string;
  groupLabel: string | null;
  amountKusd: number;
  usdDenominated: boolean;
  sortOrder: number;
};
export type InsertFixedCostFact = Omit<
  FixedCostFact,
  "id" | "groupLabel" | "usdDenominated" | "sortOrder"
> & { groupLabel?: string | null; usdDenominated?: boolean; sortOrder?: number };

// Itens de preço de insumo ("Cálculo" linhas 128-144). Dois formatos:
//  - itens precificados: unitPriceUsd + yieldFactor
//  - itens diretos (Alloys, Zinc, Natural Gas...): amountKusd.
export type InputPriceFact = {
  id: number;
  scenarioId: string;
  item: string;
  groupLabel: string | null;
  unitPriceUsd: number | null;
  yieldFactor: number | null;
  amountKusd: number | null;
  sortOrder: number;
};
export type InsertInputPriceFact = Omit<
  InputPriceFact,
  "id" | "groupLabel" | "unitPriceUsd" | "yieldFactor" | "amountKusd" | "sortOrder"
> & {
  groupLabel?: string | null;
  unitPriceUsd?: number | null;
  yieldFactor?: number | null;
  amountKusd?: number | null;
  sortOrder?: number;
};

// Itens de Usage / Outros / Variação de estoque ("Cálculo" linhas 147,
// 155-181). driver = usage | others | stock_variation.
export type MiscFact = {
  id: number;
  scenarioId: string;
  driver: string;
  label: string;
  groupLabel: string | null;
  amountKusd: number;
  sortOrder: number;
};
export type InsertMiscFact = Omit<MiscFact, "id" | "groupLabel" | "sortOrder"> & {
  groupLabel?: string | null;
  sortOrder?: number;
};

// ---------------------------------------------------------------------------
// Modelo dimensional (espelha os modelos do SAP SAC / Databricks).
// Fonte canônica dos indicadores: uma dimensão de itens com propriedades e uma
// fato enxuta (cenário × item × indicador → valor). As cinco tabelas "largas"
// acima são legadas: mantidas no schema para conversão de bancos existentes,
// mas não recebem mais escrita — o painel reconstrói as formas largas na
// leitura a partir de dim_items + indicator_facts.
// ---------------------------------------------------------------------------

// Dimensão de itens: chave = nome do item (único entre todas as seções);
// propriedades que antes se repetiam em cada linha da fato.
export const dimItemsTable = pgTable("dim_items", {
  item: text("item").primaryKey(), // "Global" em Parametros
  secao: text("secao").notNull(), // Parametros | Vendas | CustoFixo | Insumos | Ajustes
  moeda: text("moeda"), // BRL | USD (Vendas e CustoFixo)
  atributo: text("atributo"), // interno/externo (Vendas); consumo/outros/variacao_estoque (Ajustes)
  grupo: text("grupo"), // grupo de exibição nas tabelas detalhadas
  sortOrder: integer("sort_order").notNull().default(0),
});

// Fato de indicadores: versão e período vêm do cenário MENSAL (scenarios.id =
// fyNN_mMM_versao); item referencia a dimensão; indicador é a conta/medida.
export const indicatorFactsTable = pgTable(
  "indicator_facts",
  {
    id: serial("id").primaryKey(),
    scenarioId: text("scenario_id").notNull(),
    item: text("item")
      .notNull()
      .references(() => dimItemsTable.item, { onDelete: "cascade" }),
    indicador: text("indicador").notNull(),
    valor: doublePrecision("valor").notNull(),
  },
  (t) => [unique().on(t.scenarioId, t.item, t.indicador)],
);

export type DimItem = typeof dimItemsTable.$inferSelect;
export type InsertDimItem = typeof dimItemsTable.$inferInsert;
export type IndicatorFact = typeof indicatorFactsTable.$inferSelect;
export type InsertIndicatorFact = typeof indicatorFactsTable.$inferInsert;

// Waterfall driver catalog (order and Portuguese labels).
export const BRIDGE_DRIVERS = [
  { key: "vol_mix", label: "Volume & Mix" },
  { key: "selling_price", label: "Selling Price" },
  { key: "input_price", label: "Input Prices" },
  { key: "usage", label: "Usage" },
  { key: "fixed_cost", label: "Fixed Cost" },
  { key: "forex", label: "Forex" },
  // Barra única combinando Variação de estoque e Outros; o detalhamento
  // (drill-down) mostra os dois grupos separados.
  { key: "sv_others", label: "Stock / Others" },
] as const;

export const insertScenarioSchema = createInsertSchema(scenariosTable);
export type InsertScenario = z.infer<typeof insertScenarioSchema>;
export type Scenario = typeof scenariosTable.$inferSelect;

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

// Explicações de mercado LEGADAS (pareadas por origem×destino). As tabelas
// físicas (market_explanations, market_explanation_lines,
// market_explanation_items) foram removidas do banco: o seed converte bancos
// antigos para o formato por versão e depois as derruba (DROP). Os tipos
// permanecem porque a conversão (market-migrate) trabalha com estas formas.
export type MarketExplanation = {
  id: number;
  sourceId: string;
  targetId: string;
  title: string; // e.g. "Iron Ores"
  unitLabel: string;
  sortOrder: number;
};

export type MarketExplanationLine = {
  id: number;
  explanationId: number;
  label: string;
  sourceValue: number | null;
  targetValue: number | null;
  varValue: number | null;
  volumeKt: number | null;
  impactMusd: number;
  sortOrder: number;
};

export type MarketExplanationItem = {
  id: number;
  explanationId: number;
  item: string; // label of the impacted bridge item
};

// Novo modelo (por versão): cada indicador (ex.: Iron Ores) tem linhas (ex.:
// "Iron ore MB 62% (1m lag)") com VALORES armazenados por cenário MENSAL
// (versão × mês) — como os indicadores. A diferença entre cenários e o
// impacto ($m) são calculados na leitura, depois da seleção do par.
export const marketIndicatorsTable = pgTable("market_indicators", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(), // e.g. "Iron Ores"
  unitLabel: text("unit_label").notNull().default("Price $/t"),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const marketIndicatorLinesTable = pgTable("market_indicator_lines", {
  id: serial("id").primaryKey(),
  indicatorId: integer("indicator_id")
    .notNull()
    .references(() => marketIndicatorsTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  // "price": valor é preço; impacto = direction × (destino − origem) × kt.
  // "amount": valor é montante em MUSD; impacto = direction × (destino − origem).
  kind: text("kind").notNull().default("price"),
  // +1 quando o aumento do valor melhora o EBITDA; -1 quando piora (custo).
  direction: integer("direction").notNull().default(-1),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const marketIndicatorValuesTable = pgTable(
  "market_indicator_values",
  {
    id: serial("id").primaryKey(),
    lineId: integer("line_id")
      .notNull()
      .references(() => marketIndicatorLinesTable.id, { onDelete: "cascade" }),
    scenarioId: text("scenario_id").notNull(), // cenário MENSAL (fyNN_mMM_versao)
    value: doublePrecision("value"),
    volumeKt: doublePrecision("volume_kt"),
  },
  (t) => [unique().on(t.lineId, t.scenarioId)],
);

export const marketIndicatorItemsTable = pgTable("market_indicator_items", {
  id: serial("id").primaryKey(),
  indicatorId: integer("indicator_id")
    .notNull()
    .references(() => marketIndicatorsTable.id, { onDelete: "cascade" }),
  item: text("item").notNull(), // label of the impacted bridge item
});

export type MarketIndicator = typeof marketIndicatorsTable.$inferSelect;
export type InsertMarketIndicator = typeof marketIndicatorsTable.$inferInsert;
export type MarketIndicatorLine = typeof marketIndicatorLinesTable.$inferSelect;
export type InsertMarketIndicatorLine = typeof marketIndicatorLinesTable.$inferInsert;
export type MarketIndicatorValue = typeof marketIndicatorValuesTable.$inferSelect;
export type InsertMarketIndicatorValue = typeof marketIndicatorValuesTable.$inferInsert;
export type MarketIndicatorItem = typeof marketIndicatorItemsTable.$inferSelect;
export type InsertMarketIndicatorItem = typeof marketIndicatorItemsTable.$inferInsert;

export const insertBridgeExplanationSchema = createInsertSchema(
  bridgeExplanationsTable,
).omit({ id: true, createdAt: true });
export type InsertBridgeExplanation = z.infer<
  typeof insertBridgeExplanationSchema
>;
export type BridgeExplanation = typeof bridgeExplanationsTable.$inferSelect;
