import { Router, type IRouter } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  marketExplanationsTable,
  marketExplanationLinesTable,
  marketExplanationItemsTable,
} from "@workspace/db";

const router: IRouter = Router();

// GET /bridge/market-explanations?source&target — imported market explanation
// tables (e.g. Iron Ores) for a pair, with detail lines and impacted items.
router.get("/bridge/market-explanations", async (req, res) => {
  const source = typeof req.query.source === "string" ? req.query.source : "";
  const target = typeof req.query.target === "string" ? req.query.target : "";
  if (!source || !target) {
    return res
      .status(400)
      .json({ error: "Informe os cenários de origem e destino." });
  }
  const heads = await db
    .select()
    .from(marketExplanationsTable)
    .where(
      and(
        eq(marketExplanationsTable.sourceId, source),
        eq(marketExplanationsTable.targetId, target),
      ),
    )
    .orderBy(
      asc(marketExplanationsTable.sortOrder),
      asc(marketExplanationsTable.id),
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

  const explanations = heads.map((h) => {
    const myLines = lines.filter((l) => l.explanationId === h.id);
    return {
      id: h.id,
      sourceId: h.sourceId,
      targetId: h.targetId,
      title: h.title,
      unitLabel: h.unitLabel,
      totalMusd: myLines.reduce((acc, l) => acc + l.impactMusd, 0),
      items: items.filter((i) => i.explanationId === h.id).map((i) => i.item),
      lines: myLines.map((l) => ({
        id: l.id,
        label: l.label,
        ...(l.sourceValue != null ? { sourceValue: l.sourceValue } : {}),
        ...(l.targetValue != null ? { targetValue: l.targetValue } : {}),
        ...(l.varValue != null ? { varValue: l.varValue } : {}),
        ...(l.volumeKt != null ? { volumeKt: l.volumeKt } : {}),
        impactMusd: l.impactMusd,
      })),
    };
  });
  return res.json({ explanations });
});

export default router;
