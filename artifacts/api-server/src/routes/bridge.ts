import { Router, type IRouter } from "express";
import { asc, eq, inArray } from "drizzle-orm";
import {
  db,
  scenariosTable,
  scenarioFactsTable,
  scenarioDetailFactsTable,
  BRIDGE_DRIVERS,
  type Scenario,
} from "@workspace/db";
import {
  GetBridgeResponse,
  GetBridgeComponentParams,
  GetBridgeComponentResponse,
  GetBridgeSummaryResponse,
  ListScenariosResponse,
} from "@workspace/api-zod";

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

type Facts = Map<string, number>; // metric -> valueMusd

async function loadCatalog() {
  const [scenarios, facts] = await Promise.all([
    db.select().from(scenariosTable).orderBy(asc(scenariosTable.sortOrder)),
    db
      .select({ scenarioId: scenarioFactsTable.scenarioId })
      .from(scenarioFactsTable)
      .where(eq(scenarioFactsTable.metric, "ebitda")),
  ]);
  const withData = new Set(facts.map((f) => f.scenarioId));
  return { scenarios, withData };
}

/**
 * Resolve the source/target scenarios for the request, computing their facts.
 * Missing params fall back to the default pair (first/last version with data).
 * Returns undefined when either scenario is unknown or has no imported data.
 */
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

  const factRows = await db
    .select()
    .from(scenarioFactsTable)
    .where(inArray(scenarioFactsTable.scenarioId, [source.id, target.id]));
  const factsOf = (id: string): Facts =>
    new Map(
      factRows.filter((f) => f.scenarioId === id).map((f) => [f.metric, f.valueMusd]),
    );
  return {
    source,
    target,
    sourceFacts: factsOf(source.id),
    targetFacts: factsOf(target.id),
  };
}

function level(facts: Facts, metric: string): number {
  return facts.get(metric) ?? 0;
}

/** Compute the waterfall steps on the fly: delta = target − source per driver. */
function computeSteps(pair: {
  source: Scenario;
  target: Scenario;
  sourceFacts: Facts;
  targetFacts: Facts;
}) {
  const start = level(pair.sourceFacts, "ebitda");
  const end = level(pair.targetFacts, "ebitda");
  const deltas = BRIDGE_DRIVERS.map((d) => ({
    key: d.key,
    label: d.label,
    value: level(pair.targetFacts, d.key) - level(pair.sourceFacts, d.key),
  }));
  return { start, end, deltas };
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

  const { start, end, deltas } = computeSteps(pair);
  const detailRows = await db
    .select({ componentKey: scenarioDetailFactsTable.componentKey })
    .from(scenarioDetailFactsTable)
    .where(
      inArray(scenarioDetailFactsTable.scenarioId, [
        pair.source.id,
        pair.target.id,
      ]),
    );
  const withDetail = new Set(detailRows.map((r) => r.componentKey));

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
    ...deltas.map((d) => {
      cumulative += d.value;
      return {
        key: d.key,
        label: d.label,
        value: d.value,
        cumulative,
        kind: "delta",
        hasDetail: withDetail.has(d.key),
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

  const rows = await db
    .select()
    .from(scenarioDetailFactsTable)
    .where(
      inArray(scenarioDetailFactsTable.scenarioId, [
        pair.source.id,
        pair.target.id,
      ]),
    );
  const forKey = rows.filter((r) => r.componentKey === driver.key);
  if (forKey.length === 0) {
    res.status(404).json({ error: "Componente não encontrado" });
    return;
  }

  // Diff detail lines on the fly: target level − source level per (group, label).
  // Missing rows mean level 0 (BUDGET is the common reference).
  type LineAgg = {
    label: string;
    group: string | null;
    value: number;
    sortOrder: number;
  };
  const byId = new Map<string, LineAgg>();
  for (const r of forKey) {
    const id = `${r.group ?? ""}\u0000${r.label}`;
    const sign = r.scenarioId === pair.target.id ? 1 : -1;
    const existing = byId.get(id);
    if (existing) {
      existing.value += sign * r.valueMusd;
      existing.sortOrder = Math.min(existing.sortOrder, r.sortOrder);
    } else {
      byId.set(id, {
        label: r.label,
        group: r.group,
        value: sign * r.valueMusd,
        sortOrder: r.sortOrder,
      });
    }
  }
  const lines = [...byId.values()]
    .sort(
      (a, b) =>
        (a.group ?? "").localeCompare(b.group ?? "") || a.sortOrder - b.sortOrder,
    )
    .map((l, i) => ({
      id: i + 1,
      label: l.label,
      group: l.group,
      value: l.value,
      sortOrder: l.sortOrder,
    }));

  const value =
    level(pair.targetFacts, driver.key) - level(pair.sourceFacts, driver.key);

  res.json(
    GetBridgeComponentResponse.parse({
      key: driver.key,
      label: driver.label,
      value,
      unit: UNIT,
      lines,
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

  const { start, end, deltas } = computeSteps(pair);
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
