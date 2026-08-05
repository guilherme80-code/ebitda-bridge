import { Router, type IRouter } from "express";
import { asc, inArray } from "drizzle-orm";
import {
  db,
  scenariosTable,
  scenarioParamsTable,
  salesFactsTable,
  fixedCostFactsTable,
  inputPriceFactsTable,
  miscFactsTable,
  BRIDGE_DRIVERS,
  type Scenario,
} from "@workspace/db";
import {
  GetBridgeResponse,
  GetBridgeComponentParams,
  GetBridgeComponentResponse,
  GetBridgeSummaryResponse,
  GetBridgeTablesResponse,
  ListScenariosResponse,
  SimulateBridgeBody,
  SimulateBridgeResponse,
} from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  simulateBridge,
  buildCatalog,
  type Adjustment,
} from "../lib/simulate";
import { computeBridge, type RawScenarioData } from "../lib/bridge-calc";

const router: IRouter = Router();

const UNIT = "MUSD";
const NO_DATA_ERROR =
  "Não há dados importados para a combinação de cenários selecionada";
const KIND_MISMATCH_ERROR =
  "Compare períodos do mesmo tipo: ano com ano, trimestre com trimestre ou mês com mês";

function firstStr(v: unknown): string | undefined {
  if (Array.isArray(v)) v = v[0];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

async function loadCatalog() {
  const [scenarios, withParams, withSales] = await Promise.all([
    db.select().from(scenariosTable).orderBy(asc(scenariosTable.sortOrder)),
    db
      .select({ scenarioId: scenarioParamsTable.scenarioId })
      .from(scenarioParamsTable),
    db
      .selectDistinct({ scenarioId: salesFactsTable.scenarioId })
      .from(salesFactsTable),
  ]);
  // Um cenário "tem dados" quando existem parâmetros E linhas de vendas —
  // evita calcular um bridge enganoso a partir de importação parcial
  // (o plug de estoque fecharia a ponte mesmo faltando dados brutos).
  const salesIds = new Set(withSales.map((s) => s.scenarioId));
  const withData = new Set(
    withParams.map((p) => p.scenarioId).filter((id) => salesIds.has(id)),
  );
  return { scenarios, withData };
}

function defaultPair(scenarios: Scenario[], withData: Set<string>) {
  // Preferência: par real FY26 Budget → FY26 MRF7; senão, primeiro/último
  // cenário anual com dados.
  const preferred = ["fy26_fy_budget", "fy26_fy_mrf7"];
  if (preferred.every((id) => withData.has(id))) {
    return { sourceId: preferred[0], targetId: preferred[1] };
  }
  const years = scenarios.filter(
    (s) => s.periodKind === "year" && withData.has(s.id),
  );
  if (years.length < 2) return undefined;
  return { sourceId: years[0].id, targetId: years[years.length - 1].id };
}

/** Carrega os dados brutos (vendas, custo fixo, insumos, misc) de um cenário. */
async function loadRaw(ids: string[]): Promise<Map<string, RawScenarioData>> {
  const [params, sales, fixed, inputs, misc] = await Promise.all([
    db
      .select()
      .from(scenarioParamsTable)
      .where(inArray(scenarioParamsTable.scenarioId, ids)),
    db
      .select()
      .from(salesFactsTable)
      .where(inArray(salesFactsTable.scenarioId, ids)),
    db
      .select()
      .from(fixedCostFactsTable)
      .where(inArray(fixedCostFactsTable.scenarioId, ids)),
    db
      .select()
      .from(inputPriceFactsTable)
      .where(inArray(inputPriceFactsTable.scenarioId, ids)),
    db
      .select()
      .from(miscFactsTable)
      .where(inArray(miscFactsTable.scenarioId, ids)),
  ]);
  const out = new Map<string, RawScenarioData>();
  for (const p of params) {
    out.set(p.scenarioId, {
      params: p,
      sales: sales.filter((r) => r.scenarioId === p.scenarioId),
      fixed: fixed.filter((r) => r.scenarioId === p.scenarioId),
      inputs: inputs.filter((r) => r.scenarioId === p.scenarioId),
      misc: misc.filter((r) => r.scenarioId === p.scenarioId),
    });
  }
  return out;
}

/**
 * Resolve o par origem/destino e calcula o bridge na hora a partir dos dados
 * brutos, seguindo as fórmulas da aba "Cálculo".
 */
async function resolvePair(sourceId?: string, targetId?: string) {
  const { scenarios, withData } = await loadCatalog();
  const def = defaultPair(scenarios, withData);
  if (!def) return undefined;

  const effectiveSource = sourceId ?? def.sourceId;
  const effectiveTarget = targetId ?? def.targetId;

  const source = scenarios.find((s) => s.id === effectiveSource);
  const target = scenarios.find((s) => s.id === effectiveTarget);
  if (
    !source ||
    !target ||
    !withData.has(source.id) ||
    !withData.has(target.id)
  ) {
    return undefined;
  }
  if (source.periodKind !== target.periodKind) {
    return { kindMismatch: true as const };
  }

  const raw = await loadRaw([source.id, target.id]);
  const rawSource = raw.get(source.id);
  const rawTarget = raw.get(target.id);
  if (!rawSource || !rawTarget) return undefined;

  const bridge = computeBridge(rawSource, rawTarget);
  return { source, target, bridge };
}

function bridgeTitle(source: Scenario, target: Scenario) {
  return `Bridge de EBITDA — ${source.label} vs ${target.label}`;
}

router.get("/scenarios", async (_req, res): Promise<void> => {
  const { scenarios, withData } = await loadCatalog();
  const def = defaultPair(scenarios, withData);
  if (!def) {
    res.status(404).json({ error: "Nenhum dado de cenário importado" });
    return;
  }
  res.json(
    ListScenariosResponse.parse({
      scenarios: scenarios.map((s) => ({
        id: s.id,
        version: s.version,
        period: s.period,
        periodKind: s.periodKind,
        label: s.label,
        hasData: withData.has(s.id),
      })),
      defaultPair: def,
    }),
  );
});

router.get("/bridge", async (req, res): Promise<void> => {
  const pair = await resolvePair(
    firstStr(req.query.source),
    firstStr(req.query.target),
  );
  if (!pair) {
    res.status(404).json({ error: NO_DATA_ERROR });
    return;
  }
  if ("kindMismatch" in pair) {
    res.status(400).json({ error: KIND_MISMATCH_ERROR });
    return;
  }

  const { start, end, drivers, details } = pair.bridge;
  let cumulative = start;
  const steps = [
    {
      key: "ebitda_source",
      label: `EBITDA ${pair.source.label}`,
      value: start,
      cumulative: start,
      kind: "total_start",
      hasDetail: false,
    },
    ...BRIDGE_DRIVERS.map((d) => {
      const value = drivers[d.key] ?? 0;
      cumulative += value;
      return {
        key: d.key,
        label: d.label,
        value,
        cumulative,
        kind: "delta",
        hasDetail: (details[d.key]?.length ?? 0) > 0,
      };
    }),
    {
      key: "ebitda_target",
      label: `EBITDA ${pair.target.label}`,
      value: end,
      cumulative: end,
      kind: "total_end",
      hasDetail: false,
    },
  ];

  res.json(
    GetBridgeResponse.parse({
      title: bridgeTitle(pair.source, pair.target),
      unit: UNIT,
      steps,
    }),
  );
});

router.get("/bridge/components/:key", async (req, res): Promise<void> => {
  const params = GetBridgeComponentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const pair = await resolvePair(
    firstStr(req.query.source),
    firstStr(req.query.target),
  );
  if (!pair) {
    res.status(404).json({ error: NO_DATA_ERROR });
    return;
  }
  if ("kindMismatch" in pair) {
    res.status(400).json({ error: KIND_MISMATCH_ERROR });
    return;
  }

  const driver = BRIDGE_DRIVERS.find((d) => d.key === params.data.key);
  if (!driver) {
    res.status(404).json({ error: "Componente não encontrado" });
    return;
  }
  const detail = pair.bridge.details[driver.key] ?? [];
  if (detail.length === 0) {
    res.status(404).json({ error: "Componente não encontrado" });
    return;
  }

  const lines = detail.map((l, i) => ({
    id: i + 1,
    label: l.label,
    group: l.group,
    value: l.value,
    sortOrder: l.sortOrder,
  }));

  res.json(
    GetBridgeComponentResponse.parse({
      key: driver.key,
      label: driver.label,
      value: pair.bridge.drivers[driver.key] ?? 0,
      unit: UNIT,
      lines,
    }),
  );
});

const ADJUSTMENT_SCOPES = new Set([
  "sales_qty",
  "sales_price",
  "fixed_cost",
  "input_price",
  "usage",
  "others",
  "fx",
]);

router.post("/bridge/simulate", async (req, res): Promise<void> => {
  const body = SimulateBridgeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Informe um prompt de simulação." });
    return;
  }

  const pair = await resolvePair(
    firstStr(req.query.source),
    firstStr(req.query.target),
  );
  if (!pair) {
    res.status(404).json({ error: NO_DATA_ERROR });
    return;
  }
  if ("kindMismatch" in pair) {
    res.status(400).json({ error: KIND_MISMATCH_ERROR });
    return;
  }

  const raw = await loadRaw([pair.source.id, pair.target.id]);
  const rawSource = raw.get(pair.source.id)!;
  const rawTarget = raw.get(pair.target.id)!;
  const catalog = buildCatalog(rawSource, rawTarget);

  const system = `Você interpreta instruções de simulação ("what-if") de um bridge de EBITDA de uma siderúrgica e responde APENAS com JSON válido.

Par comparado: origem = "${pair.source.label}" (versão ${pair.source.version}), destino = "${pair.target.label}" (versão ${pair.target.version}).

Itens ajustáveis (use os rótulos EXATOS):
- sales_qty / sales_price (produtos de venda): ${JSON.stringify(catalog.sales)}
- fixed_cost (categorias de custo fixo): ${JSON.stringify(catalog.fixed_cost)}
- input_price (insumos): ${JSON.stringify(catalog.input_price)}
- usage (linhas de consumo): ${JSON.stringify(catalog.usage)}
- others (estoque/outros): ${JSON.stringify(catalog.others)}
- fx (câmbio BRL/USD): key = "fx"

Formato de saída:
{"interpretation": "frase curta em pt-BR resumindo o que será simulado",
 "adjustments": [{"scope": "sales_qty|sales_price|fixed_cost|input_price|usage|others|fx", "scenario": "source|target", "key": "<rótulo exato>", "pct": <número ou null>, "abs": <número ou null>}]}

Regras:
- "venda X maior/menor em N%" sem menção a preço → sales_qty com pct ±N.
- Menções a preço de venda → sales_price. Preço de matéria-prima/insumo (coal, PCI, coke, pellets...) → input_price.
- "no MRF7"/"no destino"/versão do destino → scenario "target"; "no Budget"/origem → "source". Sem indicação → "target".
- pct: use sinal (queda de 10% → -10). abs: kt para volume, USD/t para preços, MUSD para montantes.
- Se o pedido não fizer sentido ou não corresponder a nenhum item, devolva {"interpretation": "...explicação...", "adjustments": []}.`;

  let parsed: { interpretation?: string; adjustments?: Adjustment[] };
  try {
    const completion = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: body.data.prompt }],
    });
    const text = completion.content.find((block) => block.type === "text");
    const rawText = text?.type === "text" ? text.text.trim() : "{}";
    const jsonText = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.error("simulate: falha ao interpretar prompt", err);
    res.status(400).json({
      error: "Não foi possível interpretar o prompt. Tente reformular.",
    });
    return;
  }

  const adjustments = (parsed.adjustments ?? []).filter(
    (a) =>
      a &&
      ADJUSTMENT_SCOPES.has(a.scope) &&
      (a.scenario === "source" || a.scenario === "target") &&
      typeof a.key === "string" &&
      (typeof a.pct === "number" || typeof a.abs === "number"),
  );
  if (!adjustments.length) {
    res.status(400).json({
      error:
        parsed.interpretation ||
        "Não identifiquei nenhum ajuste no prompt. Ex.: \"venda de Slab Calvert 10% maior no MRF7\".",
    });
    return;
  }

  const outcome = simulateBridge(rawSource, rawTarget, adjustments, {
    source: pair.source.label,
    target: pair.target.label,
  });
  if (!outcome.applied.length) {
    res.status(400).json({
      error: `Não encontrei os itens citados (${outcome.notFound.join(", ")}).`,
    });
    return;
  }

  const { start, end, drivers, details } = outcome.bridge;
  let cumulative = start;
  const steps = [
    {
      key: "ebitda_source",
      label: `EBITDA ${pair.source.label}`,
      value: start,
      cumulative: start,
      kind: "total_start",
      hasDetail: false,
    },
    ...BRIDGE_DRIVERS.map((d) => {
      const value = drivers[d.key] ?? 0;
      cumulative += value;
      return {
        key: d.key,
        label: d.label,
        value,
        cumulative,
        kind: "delta",
        hasDetail: (details[d.key]?.length ?? 0) > 0,
      };
    }),
    {
      key: "ebitda_target",
      label: `EBITDA ${pair.target.label} (simulado)`,
      value: end,
      cumulative: end,
      kind: "total_end",
      hasDetail: false,
    },
  ];

  res.json(
    SimulateBridgeResponse.parse({
      title: `Simulação — ${pair.source.label} vs ${pair.target.label}`,
      unit: UNIT,
      interpretation: parsed.interpretation ?? outcome.applied.join("; "),
      adjustments: outcome.applied,
      steps,
      deltaEbitda: end - pair.bridge.end,
    }),
  );
});

router.get("/bridge/tables", async (req, res): Promise<void> => {
  const pair = await resolvePair(
    firstStr(req.query.source),
    firstStr(req.query.target),
  );
  if (!pair) {
    res.status(404).json({ error: NO_DATA_ERROR });
    return;
  }
  if ("kindMismatch" in pair) {
    res.status(400).json({ error: KIND_MISMATCH_ERROR });
    return;
  }

  res.json(
    GetBridgeTablesResponse.parse({
      title: bridgeTitle(pair.source, pair.target),
      unit: UNIT,
      tables: pair.bridge.tables,
    }),
  );
});

router.get("/bridge/summary", async (req, res): Promise<void> => {
  const pair = await resolvePair(
    firstStr(req.query.source),
    firstStr(req.query.target),
  );
  if (!pair) {
    res.status(404).json({ error: NO_DATA_ERROR });
    return;
  }
  if ("kindMismatch" in pair) {
    res.status(400).json({ error: KIND_MISMATCH_ERROR });
    return;
  }

  const { start, end, drivers } = pair.bridge;
  const deltas = BRIDGE_DRIVERS.map((d) => ({
    key: d.key,
    label: d.label,
    value: drivers[d.key] ?? 0,
  }));
  const largestPositive = deltas.reduce((a, b) => (b.value > a.value ? b : a));
  const largestNegative = deltas.reduce((a, b) => (b.value < a.value ? b : a));
  const positiveTotal = deltas
    .filter((d) => d.value > 0)
    .reduce((s, d) => s + d.value, 0);
  const negativeTotal = deltas
    .filter((d) => d.value < 0)
    .reduce((s, d) => s + d.value, 0);

  res.json(
    GetBridgeSummaryResponse.parse({
      startLabel: `EBITDA ${pair.source.label}`,
      startValue: start,
      endLabel: `EBITDA ${pair.target.label}`,
      endValue: end,
      totalVariation: end - start,
      largestPositive,
      largestNegative,
      positiveTotal,
      negativeTotal,
    }),
  );
});

export default router;
