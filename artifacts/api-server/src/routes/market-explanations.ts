import { Router, type IRouter } from "express";
import { asc, inArray } from "drizzle-orm";
import {
  db,
  marketIndicatorsTable,
  marketIndicatorLinesTable,
  marketIndicatorValuesTable,
  marketIndicatorItemsTable,
} from "@workspace/db";
import {
  monthPairsOf,
  consolidateMarketIndicators,
} from "../lib/market-consolidate";

const router: IRouter = Router();

// GET /bridge/market-explanations?source&target — explicações importadas (ex.:
// Iron Ores). Os VALORES são armazenados por versão e mês; a diferença entre
// os cenários e o impacto são calculados aqui, depois da seleção do par. Para
// pares FY/trimestre, expande em pares mensais, calcula cada mês e soma.
router.get("/bridge/market-explanations", async (req, res) => {
  const source = typeof req.query.source === "string" ? req.query.source : "";
  const target = typeof req.query.target === "string" ? req.query.target : "";
  if (!source || !target) {
    return res
      .status(400)
      .json({ error: "Provide the source and target scenarios." });
  }
  const pairs = monthPairsOf(source, target);
  if (pairs === null) {
    return res.status(400).json({
      error:
        "Source and target periods have different granularities (year vs quarter vs month).",
    });
  }
  if (pairs.length === 0) return res.json({ explanations: [] });

  const scenarioIds = [
    ...new Set(pairs.flatMap((p) => [p.sourceId, p.targetId])),
  ];
  const values = await db
    .select()
    .from(marketIndicatorValuesTable)
    .where(inArray(marketIndicatorValuesTable.scenarioId, scenarioIds));
  if (values.length === 0) return res.json({ explanations: [] });

  const lineIds = [...new Set(values.map((v) => v.lineId))];
  const lines = await db
    .select()
    .from(marketIndicatorLinesTable)
    .where(inArray(marketIndicatorLinesTable.id, lineIds))
    .orderBy(
      asc(marketIndicatorLinesTable.sortOrder),
      asc(marketIndicatorLinesTable.id),
    );
  const indicatorIds = [...new Set(lines.map((l) => l.indicatorId))];
  const [indicators, items] = await Promise.all([
    db
      .select()
      .from(marketIndicatorsTable)
      .where(inArray(marketIndicatorsTable.id, indicatorIds)),
    db
      .select()
      .from(marketIndicatorItemsTable)
      .where(inArray(marketIndicatorItemsTable.indicatorId, indicatorIds))
      .orderBy(asc(marketIndicatorItemsTable.id)),
  ]);

  const explanations = consolidateMarketIndicators(
    { sourceId: source, targetId: target },
    pairs,
    indicators,
    lines,
    values,
    items,
  );
  return res.json({ explanations });
});

export default router;
