import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  scenariosTable,
  bridgesTable,
  bridgeComponentsTable,
  bridgeDetailLinesTable,
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

function firstStr(v: unknown): string | undefined {
  if (Array.isArray(v)) v = v[0];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Resolve the bridge for the requested source/target pair.
 * Missing params fall back to the default bridge.
 */
async function resolveBridge(source?: string, target?: string) {
  const [def] = await db
    .select()
    .from(bridgesTable)
    .where(eq(bridgesTable.isDefault, true))
    .limit(1);

  // Each missing param falls back independently to the default bridge's value.
  const effectiveSource = source ?? def?.sourceScenarioId;
  const effectiveTarget = target ?? def?.targetScenarioId;
  if (!effectiveSource || !effectiveTarget) return undefined;

  if (
    def &&
    def.sourceScenarioId === effectiveSource &&
    def.targetScenarioId === effectiveTarget
  ) {
    return def;
  }

  const [bridge] = await db
    .select()
    .from(bridgesTable)
    .where(
      and(
        eq(bridgesTable.sourceScenarioId, effectiveSource),
        eq(bridgesTable.targetScenarioId, effectiveTarget),
      ),
    );
  return bridge;
}

async function loadComponents(bridgeId: number) {
  return db
    .select()
    .from(bridgeComponentsTable)
    .where(eq(bridgeComponentsTable.bridgeId, bridgeId))
    .orderBy(asc(bridgeComponentsTable.sortOrder));
}

router.get("/scenarios", async (_req, res): Promise<void> => {
  const [scenarios, bridges] = await Promise.all([
    db.select().from(scenariosTable).orderBy(asc(scenariosTable.sortOrder)),
    db.select().from(bridgesTable),
  ]);
  const def = bridges.find((b) => b.isDefault) ?? bridges[0];
  if (!def) {
    res.status(404).json({ error: "Nenhum bridge importado" });
    return;
  }
  res.json(
    ListScenariosResponse.parse({
      scenarios: scenarios.map((s) => ({
        id: s.id,
        version: s.version,
        period: s.period,
        label: s.label,
      })),
      pairs: bridges.map((b) => ({
        sourceId: b.sourceScenarioId,
        targetId: b.targetScenarioId,
      })),
      defaultPair: {
        sourceId: def.sourceScenarioId,
        targetId: def.targetScenarioId,
      },
    }),
  );
});

router.get("/bridge", async (req, res): Promise<void> => {
  const bridge = await resolveBridge(
    firstStr(req.query.source),
    firstStr(req.query.target),
  );
  if (!bridge) {
    res
      .status(404)
      .json({ error: "Não há bridge para a combinação de cenários selecionada" });
    return;
  }

  const components = await loadComponents(bridge.id);
  const detailRows = await db
    .select({ componentKey: bridgeDetailLinesTable.componentKey })
    .from(bridgeDetailLinesTable)
    .where(eq(bridgeDetailLinesTable.bridgeId, bridge.id));
  const withDetail = new Set(detailRows.map((r) => r.componentKey));

  let cumulative = 0;
  const steps = components.map((c) => {
    if (c.kind === "total_start") {
      cumulative = c.valueMusd;
    } else if (c.kind === "delta") {
      cumulative += c.valueMusd;
    }
    return {
      key: c.key,
      label: c.label,
      value: c.valueMusd,
      cumulative: c.kind === "total_end" ? c.valueMusd : cumulative,
      kind: c.kind,
      hasDetail: withDetail.has(c.key),
    };
  });

  res.json(GetBridgeResponse.parse({ title: bridge.title, unit: UNIT, steps }));
});

router.get("/bridge/components/:key", async (req, res): Promise<void> => {
  const params = GetBridgeComponentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const bridge = await resolveBridge(
    firstStr(req.query.source),
    firstStr(req.query.target),
  );
  if (!bridge) {
    res
      .status(404)
      .json({ error: "Não há bridge para a combinação de cenários selecionada" });
    return;
  }

  const [component] = await db
    .select()
    .from(bridgeComponentsTable)
    .where(
      and(
        eq(bridgeComponentsTable.bridgeId, bridge.id),
        eq(bridgeComponentsTable.key, params.data.key),
      ),
    );

  if (!component) {
    res.status(404).json({ error: "Componente não encontrado" });
    return;
  }

  const lines = await db
    .select()
    .from(bridgeDetailLinesTable)
    .where(
      and(
        eq(bridgeDetailLinesTable.bridgeId, bridge.id),
        eq(bridgeDetailLinesTable.componentKey, params.data.key),
      ),
    )
    .orderBy(
      asc(bridgeDetailLinesTable.group),
      asc(bridgeDetailLinesTable.sortOrder),
    );

  res.json(
    GetBridgeComponentResponse.parse({
      key: component.key,
      label: component.label,
      value: component.valueMusd,
      unit: UNIT,
      lines: lines.map((l) => ({
        id: l.id,
        label: l.label,
        group: l.group,
        value: l.valueMusd,
        sortOrder: l.sortOrder,
      })),
    }),
  );
});

router.get("/bridge/summary", async (req, res): Promise<void> => {
  const bridge = await resolveBridge(
    firstStr(req.query.source),
    firstStr(req.query.target),
  );
  if (!bridge) {
    res
      .status(404)
      .json({ error: "Não há bridge para a combinação de cenários selecionada" });
    return;
  }

  const components = await loadComponents(bridge.id);
  const start = components.find((c) => c.kind === "total_start");
  const end = components.find((c) => c.kind === "total_end");
  const deltas = components.filter((c) => c.kind === "delta");

  if (!start || !end || deltas.length === 0) {
    res.status(404).json({ error: "Bridge não importado" });
    return;
  }

  const largestPositive = deltas.reduce((a, b) =>
    b.valueMusd > a.valueMusd ? b : a,
  );
  const largestNegative = deltas.reduce((a, b) =>
    b.valueMusd < a.valueMusd ? b : a,
  );
  const positiveTotal = deltas
    .filter((d) => d.valueMusd > 0)
    .reduce((s, d) => s + d.valueMusd, 0);
  const negativeTotal = deltas
    .filter((d) => d.valueMusd < 0)
    .reduce((s, d) => s + d.valueMusd, 0);

  res.json(
    GetBridgeSummaryResponse.parse({
      startLabel: start.label,
      startValue: start.valueMusd,
      endLabel: end.label,
      endValue: end.valueMusd,
      totalVariation: end.valueMusd - start.valueMusd,
      largestPositive: {
        key: largestPositive.key,
        label: largestPositive.label,
        value: largestPositive.valueMusd,
      },
      largestNegative: {
        key: largestNegative.key,
        label: largestNegative.label,
        value: largestNegative.valueMusd,
      },
      positiveTotal,
      negativeTotal,
    }),
  );
});

export default router;
