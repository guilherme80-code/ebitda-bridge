import { Router, type IRouter } from "express";
import { inArray } from "drizzle-orm";
import {
  db,
  scenariosTable,
  dimItemsTable,
  indicatorFactsTable,
  BRIDGE_DRIVERS,
  type Scenario,
} from "@workspace/db";
import { buildRawScenarios, scenariosWithData } from "../lib/indicator-model";

/** Alavancas a exibir para um bridge (barra "Estoque / Outros" é única). */
function bridgeDriverList(
  _drivers: Record<string, number>,
): { key: string; label: string }[] {
  return [...BRIDGE_DRIVERS];
}

/**
 * Passo "Não Explicado": só existe quando os dados da fonte não fecham o
 * bridge (diferença ≥ 0,05 MUSD). Entra logo antes do EBITDA destino.
 */
const UNEXPLAINED_EPS = 0.05;
const UNEXPLAINED_KEY = "unexplained";
const UNEXPLAINED_LABEL = "Unexplained";

function unexplainedStep(
  discrepancy: number,
  end: number,
): {
  key: string;
  label: string;
  value: number;
  cumulative: number;
  kind: string;
  hasDetail: boolean;
}[] {
  if (Math.abs(discrepancy) < UNEXPLAINED_EPS) return [];
  return [
    {
      key: UNEXPLAINED_KEY,
      label: UNEXPLAINED_LABEL,
      value: discrepancy,
      cumulative: end,
      kind: "delta",
      hasDetail: false,
    },
  ];
}
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
  buildSimulatedTables,
  type Adjustment,
} from "../lib/simulate";
import { computeBridge, type RawScenarioData } from "../lib/bridge-calc";
import {
  deriveScenarios,
  aggregateMonths,
  compareScenarios,
  monthPeriodLabel,
  type DerivedScenario,
} from "../lib/aggregate";
import { defaultScenarioPair } from "../lib/scenario-catalog";

const router: IRouter = Router();

const UNIT = "MUSD";
const NO_DATA_ERROR =
  "No imported data for the selected scenario combination";
const KIND_MISMATCH_ERROR =
  "Compare periods of the same kind: year with year, quarter with quarter, or month with month";

function firstStr(v: unknown): string | undefined {
  if (Array.isArray(v)) v = v[0];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export async function loadCatalog() {
  const [loadedScenarios, dims, facts] = await Promise.all([
    db.select().from(scenariosTable),
    db.select().from(dimItemsTable),
    db
      .select({
        scenarioId: indicatorFactsTable.scenarioId,
        item: indicatorFactsTable.item,
        indicador: indicatorFactsTable.indicador,
        valor: indicatorFactsTable.valor,
      })
      .from(indicatorFactsTable),
  ]);
  const scenarios = loadedScenarios.sort(compareScenarios);
  // Um cenário "tem dados" quando existem parâmetros completos E linhas de
  // vendas — evita calcular um bridge enganoso a partir de importação parcial
  // (o plug de estoque fecharia a ponte mesmo faltando dados brutos).
  const withData = scenariosWithData(buildRawScenarios(dims, facts));

  // A fonte é mensal; FY e trimestres são cenários DERIVADOS, consolidados
  // dos meses da versão. Um derivado só tem dados quando todos os seus meses
  // têm dados (nada de FY parcial fechado no plug).
  const derived = deriveScenarios(scenarios.filter((s) => s.periodKind === "month"));
  const derivedById = new Map<string, DerivedScenario>();
  for (const d of derived) {
    derivedById.set(d.id, d);
    if (d.monthIds.every((id) => withData.has(id))) withData.add(d.id);
  }
  const all = [...derived, ...scenarios.filter((s) => s.periodKind === "month")].sort(compareScenarios);
  return { scenarios: all, withData, derivedById };
}

/** Carrega os dados brutos (vendas, custo fixo, insumos, misc) de um cenário. */
async function loadRaw(ids: string[]): Promise<Map<string, RawScenarioData>> {
  const [dims, facts] = await Promise.all([
    db.select().from(dimItemsTable),
    db
      .select()
      .from(indicatorFactsTable)
      .where(inArray(indicatorFactsTable.scenarioId, ids)),
  ]);
  return buildRawScenarios(dims, facts);
}

/**
 * Resolve o par origem/destino e calcula o bridge na hora a partir dos dados
 * brutos, seguindo as fórmulas da aba "Cálculo".
 */
async function resolvePair(sourceId?: string, targetId?: string) {
  const { scenarios, withData, derivedById } = await loadCatalog();
  const def = defaultScenarioPair(scenarios, withData);
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

  // Cenários derivados (FY/trimestre) carregam os meses e consolidam.
  const monthIdsOf = (id: string) => derivedById.get(id)?.monthIds ?? [id];
  const sourceMonths = monthIdsOf(source.id);
  const targetMonths = monthIdsOf(target.id);
  const raw = await loadRaw([...new Set([...sourceMonths, ...targetMonths])]);
  const resolve = (id: string, monthIds: string[]) => {
    const parts = monthIds.map((m) => raw.get(m));
    if (parts.some((p) => !p)) return undefined;
    const list = parts as RawScenarioData[];
    return list.length === 1 && monthIds[0] === id
      ? list[0]
      : aggregateMonths(id, list);
  };
  const rawSource = resolve(source.id, sourceMonths);
  const rawTarget = resolve(target.id, targetMonths);
  if (!rawSource || !rawTarget) return undefined;

  const bridge = computeBridge(rawSource, rawTarget);
  return { source, target, bridge, rawSource, rawTarget };
}

function bridgeTitle(source: Scenario, target: Scenario) {
  return `EBITDA Bridge — ${source.label} vs ${target.label}`;
}

/** Substitui os genéricos "source"/"target" dos rótulos de colunas pelos
 * nomes dos cenários selecionados (ex.: "Qtd FY26 Budget (kt)"). */
function scenarioColumns<T extends { key: string; label: string }>(
  columns: T[],
  source: Scenario,
  target: Scenario,
): T[] {
  return columns.map((c) => ({
    ...c,
    label: c.label
      .replace(/\bsource\b/g, source.label)
      .replace(/\btarget\b/g, target.label),
  }));
}

router.get("/scenarios", async (_req, res): Promise<void> => {
  const { scenarios, withData, derivedById } = await loadCatalog();
  const def = defaultScenarioPair(scenarios, withData);
  if (!def) {
    res.status(404).json({ error: "No scenario data imported" });
    return;
  }
  res.json(
    ListScenariosResponse.parse({
      scenarios: scenarios.map((s) => {
        const hasData = withData.has(s.id);
        const derived = derivedById.get(s.id);
        // Derivado sem dados: informa quais meses faltam para consolidar.
        const missingMonths =
          !hasData && derived
            ? derived.monthIds
                .filter((id) => !withData.has(id))
                .map(monthPeriodLabel)
            : undefined;
        return {
          id: s.id,
          version: s.version,
          period: s.period,
          periodKind: s.periodKind,
          label: s.label,
          hasData,
          ...(missingMonths ? { missingMonths } : {}),
        };
      }),
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

  const { start, end, drivers, details, discrepancy } = pair.bridge;
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
    ...bridgeDriverList(drivers).map((d) => {
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
    ...unexplainedStep(discrepancy, end),
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

  const driver = bridgeDriverList(pair.bridge.drivers).find(
    (d) => d.key === params.data.key,
  );
  if (!driver) {
    res.status(404).json({ error: "Component not found" });
    return;
  }
  const detail = pair.bridge.details[driver.key] ?? [];
  if (detail.length === 0) {
    res.status(404).json({ error: "Component not found" });
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
    res.status(400).json({ error: "Provide a simulation prompt." });
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

  const { rawSource, rawTarget } = pair;
  const catalog = buildCatalog(rawSource, rawTarget);

  const system = `You interpret "what-if" simulation instructions for a steelmaker's EBITDA bridge and reply ONLY with valid JSON. Instructions may be written in English or Portuguese.

Compared pair: source = "${pair.source.label}" (version ${pair.source.version}), target = "${pair.target.label}" (version ${pair.target.version}).

Adjustable items (use the EXACT labels):
- sales_qty / sales_price (sales products): ${JSON.stringify(catalog.sales)}
- fixed_cost (fixed cost categories): ${JSON.stringify(catalog.fixed_cost)}
- input_price (input materials): ${JSON.stringify(catalog.input_price)}
- usage (usage lines): ${JSON.stringify(catalog.usage)}
- others (stock/others): ${JSON.stringify(catalog.others)}
- fx (BRL/USD exchange rate): key = "fx"

Output format:
{"interpretation": "short sentence in English summarizing what will be simulated",
 "adjustments": [{"scope": "sales_qty|sales_price|fixed_cost|input_price|usage|others|fx", "scenario": "source|target", "key": "<exact label>", "pct": <number or null>, "abs": <number or null>}]}

Rules:
- "sales of X higher/lower by N%" with no mention of price → sales_qty with pct ±N.
- Mentions of selling price → sales_price. Raw material / input prices (coal, PCI, coke, pellets...) → input_price.
- "in MRF7"/"in the target"/target version → scenario "target"; "in Budget"/source → "source". No indication → "target".
- pct: signed (a 10% drop → -10). abs: kt for volume, USD/t for prices, MUSD for amounts.
- If the request makes no sense or matches no item, return {"interpretation": "...explanation...", "adjustments": []}.`;

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
      error: "Could not interpret the prompt. Try rephrasing.",
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
        "No adjustment identified in the prompt. E.g. \"Slab Calvert sales 10% higher in MRF7\".",
    });
    return;
  }

  const outcome = simulateBridge(rawSource, rawTarget, adjustments, {
    source: pair.source.label,
    target: pair.target.label,
  });
  if (!outcome.applied.length) {
    res.status(400).json({
      error: `Could not find the items mentioned (${outcome.notFound.join(", ")}).`,
    });
    return;
  }

  const { start, end, drivers, details, discrepancy } = outcome.bridge;
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
    ...bridgeDriverList(drivers).map((d) => {
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
    ...unexplainedStep(discrepancy, end),
    {
      key: "ebitda_target",
      label: `EBITDA ${pair.target.label} (simulado)`,
      value: end,
      cumulative: end,
      kind: "total_end",
      hasDetail: false,
    },
  ];

  // Tabelas detalhadas recalculadas com os dados simulados, pareadas com os
  // valores originais (mesmos itens; os ajustes só alteram linhas existentes).
  const simTables = buildSimulatedTables(outcome.bridge, pair.bridge).map(
    (t) => ({
      ...t,
      columns: scenarioColumns(t.columns, pair.source, pair.target),
    }),
  );

  res.json(
    SimulateBridgeResponse.parse({
      title: `Simulation — ${pair.source.label} vs ${pair.target.label}`,
      unit: UNIT,
      interpretation: parsed.interpretation ?? outcome.applied.join("; "),
      adjustments: outcome.applied,
      steps,
      deltaEbitda: end - pair.bridge.end,
      tables: simTables,
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
      tables: pair.bridge.tables.map((t) => ({
        ...t,
        columns: scenarioColumns(t.columns, pair.source, pair.target),
      })),
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

  const { start, end, drivers, discrepancy } = pair.bridge;
  const deltas = [
    ...bridgeDriverList(drivers).map((d) => ({
      key: d.key,
      label: d.label,
      value: drivers[d.key] ?? 0,
    })),
    ...(Math.abs(discrepancy) >= UNEXPLAINED_EPS
      ? [{ key: UNEXPLAINED_KEY, label: UNEXPLAINED_LABEL, value: discrepancy }]
      : []),
  ];
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
