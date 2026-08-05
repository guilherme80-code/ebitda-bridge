import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  scenariosTable,
  fatoBridgeDetalheTable,
  BRIDGE_DRIVERS,
  type Scenario,
  type FatoBridgeDetalhe,
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
const DEFAULT_SOURCE = "fy26_budget";
const DEFAULT_TARGET = "fy26_mrf7";

function firstStr(v: unknown): string | undefined {
  if (Array.isArray(v)) v = v[0];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

async function loadScenarios(): Promise<Scenario[]> {
  return db.select().from(scenariosTable).orderBy(asc(scenariosTable.sortOrder));
}

/**
 * Resolve source/target scenarios. Missing params fall back to the default
 * pair (FY26 Budget → FY26 MRF7 when present, else first two scenarios).
 */
async function resolvePair(source?: string, target?: string) {
  const scenarios = await loadScenarios();
  if (scenarios.length < 2) return undefined;
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const defSource = byId.get(DEFAULT_SOURCE) ?? scenarios[0];
  const defTarget = byId.get(DEFAULT_TARGET) ?? scenarios[1];
  const src = source ? byId.get(source) : defSource;
  const tgt = target ? byId.get(target) : defTarget;
  if (!src || !tgt) return undefined;
  return { src, tgt, scenarios };
}

async function loadFacts(s: Scenario): Promise<FatoBridgeDetalhe[]> {
  return db
    .select()
    .from(fatoBridgeDetalheTable)
    .where(
      and(
        eq(fatoBridgeDetalheTable.versao, s.version),
        eq(fatoBridgeDetalheTable.periodo, s.period),
      ),
    );
}

type DriverDelta = {
  key: string;
  label: string;
  value: number;
};

/**
 * Compute the bridge between two scenarios from absolute facts:
 * driver delta = sum(target items, padrao+ajuste) − sum(source items).
 */
async function computeBridge(src: Scenario, tgt: Scenario) {
  const [srcFacts, tgtFacts] = await Promise.all([loadFacts(src), loadFacts(tgt)]);
  if (srcFacts.length === 0 || tgtFacts.length === 0) return undefined;

  const sumByDriver = (facts: FatoBridgeDetalhe[]) => {
    const m = new Map<string, number>();
    for (const f of facts) m.set(f.driver, (m.get(f.driver) ?? 0) + f.valorMusd);
    return m;
  };
  const srcByDriver = sumByDriver(srcFacts);
  const tgtByDriver = sumByDriver(tgtFacts);

  const total = (facts: FatoBridgeDetalhe[]) =>
    facts.reduce((s, f) => s + f.valorMusd, 0);

  const driverKeys = new Set([...srcByDriver.keys(), ...tgtByDriver.keys()]);
  const known = BRIDGE_DRIVERS.filter((d) => driverKeys.has(d.key)).map(
    (d) => ({ key: d.key, label: d.label }) as { key: string; label: string },
  );
  const unknown = [...driverKeys]
    .filter((k) => !BRIDGE_DRIVERS.some((d) => d.key === k))
    .sort()
    .map((k) => ({ key: k, label: k }));

  const deltas: DriverDelta[] = [...known, ...unknown].map((d) => ({
    key: d.key,
    label: d.label,
    value: (tgtByDriver.get(d.key) ?? 0) - (srcByDriver.get(d.key) ?? 0),
  }));

  return {
    startValue: total(srcFacts),
    endValue: total(tgtFacts),
    deltas,
    srcFacts,
    tgtFacts,
  };
}

router.get("/scenarios", async (_req, res): Promise<void> => {
  const scenarios = await loadScenarios();
  if (scenarios.length < 2) {
    res.status(404).json({ error: "Nenhum cenário importado" });
    return;
  }
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  // Any source/target combination is valid now — bridges are computed on demand.
  const pairs = scenarios.flatMap((s) =>
    scenarios.filter((t) => t.id !== s.id).map((t) => ({ sourceId: s.id, targetId: t.id })),
  );
  res.json(
    ListScenariosResponse.parse({
      scenarios: scenarios.map((s) => ({
        id: s.id,
        version: s.version,
        period: s.period,
        label: s.label,
      })),
      pairs,
      defaultPair: {
        sourceId: (byId.get(DEFAULT_SOURCE) ?? scenarios[0]).id,
        targetId: (byId.get(DEFAULT_TARGET) ?? scenarios[1]).id,
      },
    }),
  );
});

router.get("/bridge", async (req, res): Promise<void> => {
  const pair = await resolvePair(firstStr(req.query.source), firstStr(req.query.target));
  const bridge = pair ? await computeBridge(pair.src, pair.tgt) : undefined;
  if (!pair || !bridge) {
    res
      .status(404)
      .json({ error: "Não há dados para a combinação de cenários selecionada" });
    return;
  }

  let cumulative = bridge.startValue;
  const steps = [
    {
      key: "ebitda_start",
      label: `EBITDA ${pair.src.label}`,
      value: bridge.startValue,
      cumulative: bridge.startValue,
      kind: "total_start",
      hasDetail: false,
    },
    ...bridge.deltas.map((d) => {
      cumulative += d.value;
      return {
        key: d.key,
        label: d.label,
        value: d.value,
        cumulative,
        kind: "delta",
        hasDetail: true,
      };
    }),
    {
      key: "ebitda_end",
      label: `EBITDA ${pair.tgt.label}`,
      value: bridge.endValue,
      cumulative: bridge.endValue,
      kind: "total_end",
      hasDetail: false,
    },
  ];

  res.json(
    GetBridgeResponse.parse({
      title: `Bridge de EBITDA — ${pair.src.label} vs ${pair.tgt.label}`,
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

  const pair = await resolvePair(firstStr(req.query.source), firstStr(req.query.target));
  const bridge = pair ? await computeBridge(pair.src, pair.tgt) : undefined;
  if (!pair || !bridge) {
    res
      .status(404)
      .json({ error: "Não há dados para a combinação de cenários selecionada" });
    return;
  }

  const key = params.data.key;
  const component = bridge.deltas.find((d) => d.key === key);
  if (!component) {
    res.status(404).json({ error: "Componente não encontrado" });
    return;
  }

  // Delta per item (padrao): target − source.
  const srcItems = new Map<string, number>();
  for (const f of bridge.srcFacts) {
    if (f.driver !== key || f.tipoRegistro !== "padrao") continue;
    srcItems.set(f.item, (srcItems.get(f.item) ?? 0) + f.valorMusd);
  }
  const tgtItems = new Map<string, number>();
  for (const f of bridge.tgtFacts) {
    if (f.driver !== key || f.tipoRegistro !== "padrao") continue;
    tgtItems.set(f.item, (tgtItems.get(f.item) ?? 0) + f.valorMusd);
  }
  const itemNames = new Set([...srcItems.keys(), ...tgtItems.keys()]);
  const standardLines = [...itemNames]
    .map((item) => ({
      item,
      value: (tgtItems.get(item) ?? 0) - (srcItems.get(item) ?? 0),
    }))
    .filter((l) => Math.abs(l.value) > 0.0005)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  // Adjustments: source adjustments enter with inverted sign (they leave the
  // bridge), target adjustments with their own sign.
  const adjustments = [
    ...bridge.srcFacts
      .filter((f) => f.driver === key && f.tipoRegistro === "ajuste")
      .map((f) => ({ fact: f, value: -f.valorMusd, scenario: pair.src.label })),
    ...bridge.tgtFacts
      .filter((f) => f.driver === key && f.tipoRegistro === "ajuste")
      .map((f) => ({ fact: f, value: f.valorMusd, scenario: pair.tgt.label })),
  ];

  let id = 0;
  const lines = [
    ...standardLines.map((l, i) => ({
      id: ++id,
      label: l.item,
      group: null as string | null,
      value: l.value,
      sortOrder: i,
      isAdjustment: false,
      justification: null as string | null,
      responsible: null as string | null,
      status: null as string | null,
    })),
    ...adjustments.map((a, i) => ({
      id: ++id,
      label: `${a.fact.item} (${a.scenario})`,
      group: "Ajuste gerencial",
      value: a.value,
      sortOrder: i,
      isAdjustment: true,
      justification: a.fact.justificativa,
      responsible: a.fact.responsavel,
      status: a.fact.status,
    })),
  ];

  res.json(
    GetBridgeComponentResponse.parse({
      key: component.key,
      label: component.label,
      value: component.value,
      unit: UNIT,
      lines,
    }),
  );
});

router.get("/bridge/summary", async (req, res): Promise<void> => {
  const pair = await resolvePair(firstStr(req.query.source), firstStr(req.query.target));
  const bridge = pair ? await computeBridge(pair.src, pair.tgt) : undefined;
  if (!pair || !bridge) {
    res
      .status(404)
      .json({ error: "Não há dados para a combinação de cenários selecionada" });
    return;
  }

  const deltas = bridge.deltas;
  if (deltas.length === 0) {
    res.status(404).json({ error: "Sem drivers para o par selecionado" });
    return;
  }
  const largestPositive = deltas.reduce((a, b) => (b.value > a.value ? b : a));
  const largestNegative = deltas.reduce((a, b) => (b.value < a.value ? b : a));
  const positiveTotal = deltas.filter((d) => d.value > 0).reduce((s, d) => s + d.value, 0);
  const negativeTotal = deltas.filter((d) => d.value < 0).reduce((s, d) => s + d.value, 0);

  res.json(
    GetBridgeSummaryResponse.parse({
      startLabel: `EBITDA ${pair.src.label}`,
      startValue: bridge.startValue,
      endLabel: `EBITDA ${pair.tgt.label}`,
      endValue: bridge.endValue,
      totalVariation: bridge.endValue - bridge.startValue,
      largestPositive: {
        key: largestPositive.key,
        label: largestPositive.label,
        value: largestPositive.value,
      },
      largestNegative: {
        key: largestNegative.key,
        label: largestNegative.label,
        value: largestNegative.value,
      },
      positiveTotal,
      negativeTotal,
    }),
  );
});

export default router;
