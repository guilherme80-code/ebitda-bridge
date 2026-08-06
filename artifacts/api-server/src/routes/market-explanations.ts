import { Router, type IRouter } from "express";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import {
  db,
  marketExplanationsTable,
  marketExplanationLinesTable,
  marketExplanationItemsTable,
} from "@workspace/db";
import {
  monthPairsOf,
  consolidateMarketExplanations,
} from "../lib/market-consolidate";

const router: IRouter = Router();

// GET /bridge/market-explanations?source&target — explicações importadas (ex.:
// Iron Ores), armazenadas por mês. Para pares FY/trimestre, expande em pares
// mensais, soma os impactos e devolve também o detalhe mês a mês.
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

  const heads = await db
    .select()
    .from(marketExplanationsTable)
    .where(
      or(
        ...pairs.map((p) =>
          and(
            eq(marketExplanationsTable.sourceId, p.sourceId),
            eq(marketExplanationsTable.targetId, p.targetId),
          ),
        ),
      ),
    );
  if (heads.length === 0) return res.json({ explanations: [] });

  const ids = heads.map((h) => h.id);
  const [lines, items] = await Promise.all([
    db
      .select()
      .from(marketExplanationLinesTable)
      .where(inArray(marketExplanationLinesTable.explanationId, ids))
      .orderBy(
        asc(marketExplanationLinesTable.sortOrder),
        asc(marketExplanationLinesTable.id),
      ),
    db
      .select()
      .from(marketExplanationItemsTable)
      .where(inArray(marketExplanationItemsTable.explanationId, ids))
      .orderBy(asc(marketExplanationItemsTable.id)),
  ]);

  const explanations = consolidateMarketExplanations(
    { sourceId: source, targetId: target },
    pairs,
    heads,
    lines,
    items,
  );
  return res.json({ explanations });
});

export default router;
