import { Router, type IRouter } from "express";
import { desc, and, eq } from "drizzle-orm";
import { db, bridgeExplanationsTable } from "@workspace/db";
import { CreateBridgeExplanationBody } from "@workspace/api-zod";
import { loadCatalog } from "./bridge";

const router: IRouter = Router();

const MAX_TEXT_LENGTH = 2000;

function toResponse(r: typeof bridgeExplanationsTable.$inferSelect) {
  return {
    id: r.id,
    sourceId: r.sourceId,
    targetId: r.targetId,
    valueMusd: r.valueMusd,
    text: r.text,
    createdAt: r.createdAt.toISOString(),
  };
}

// GET /bridge/explanations?source&target — saved explanations for a pair,
// newest first.
router.get("/bridge/explanations", async (req, res) => {
  const source = typeof req.query.source === "string" ? req.query.source : "";
  const target = typeof req.query.target === "string" ? req.query.target : "";
  if (!source || !target) {
    return res
      .status(400)
      .json({ error: "Provide the source and target scenarios." });
  }
  const rows = await db
    .select()
    .from(bridgeExplanationsTable)
    .where(
      and(
        eq(bridgeExplanationsTable.sourceId, source),
        eq(bridgeExplanationsTable.targetId, target),
      ),
    )
    .orderBy(
      desc(bridgeExplanationsTable.createdAt),
      desc(bridgeExplanationsTable.id),
    );
  return res.json({ explanations: rows.map(toResponse) });
});

// POST /bridge/explanations — save a new explanation for a pair. The pair
// must exist in the catalog, have data and share the same period granularity
// (the same rules that make a bridge available).
router.post("/bridge/explanations", async (req, res) => {
  const parsed = CreateBridgeExplanationBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid data: provide the explanation value and text." });
  }
  const { sourceId, targetId, valueMusd } = parsed.data;
  const text = parsed.data.text.trim();
  if (!text) {
    return res
      .status(400)
      .json({ error: "Describe the explanation for the difference." });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({
      error: `The explanation must be at most ${MAX_TEXT_LENGTH} characters.`,
    });
  }
  if (!Number.isFinite(valueMusd)) {
    return res
      .status(400)
      .json({ error: "Provide a valid numeric value in MUSD." });
  }
  const { scenarios, withData } = await loadCatalog();
  const source = scenarios.find((s) => s.id === sourceId);
  const target = scenarios.find((s) => s.id === targetId);
  if (!source || !target) {
    return res.status(400).json({
      error: `Unknown scenario: ${!source ? sourceId : targetId}`,
    });
  }
  if (source.periodKind !== target.periodKind) {
    return res.status(400).json({
      error:
        "Source and target scenarios must have the same period granularity.",
    });
  }
  if (!withData.has(sourceId) || !withData.has(targetId)) {
    return res.status(400).json({
      error:
        "The scenario combination has no imported data yet to compute the bridge.",
    });
  }
  const [row] = await db
    .insert(bridgeExplanationsTable)
    .values({ sourceId, targetId, valueMusd, text })
    .returning();
  return res.status(201).json(toResponse(row));
});

// DELETE /bridge/explanations/:id — remove a saved explanation
router.delete("/bridge/explanations/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(404).json({ error: "Explanation not found." });
  }
  const deleted = await db
    .delete(bridgeExplanationsTable)
    .where(eq(bridgeExplanationsTable.id, id))
    .returning({ id: bridgeExplanationsTable.id });
  if (deleted.length === 0) {
    return res.status(404).json({ error: "Explanation not found." });
  }
  return res.status(204).end();
});

export default router;
