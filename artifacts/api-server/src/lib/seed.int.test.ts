import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";

/**
 * Teste de integração do upgrade concorrente: simula duas instâncias
 * (autoscale) subindo ao mesmo tempo contra uma base "só-legada" — sem as
 * tabelas dimensionais, mas com as tabelas largas populadas. Ambas devem
 * terminar sem erro e o resultado deve ser o modelo dimensional completo.
 *
 * Executa DDL destrutiva (DROP das tabelas dimensionais) no banco apontado
 * por DATABASE_URL, por isso só roda quando RUN_DB_INT_TESTS=1:
 *   RUN_DB_INT_TESTS=1 pnpm --filter @workspace/api-server test seed.int
 */
describe.runIf(process.env["RUN_DB_INT_TESTS"] === "1")(
  "upgrade dimensional concorrente (base só-legada)",
  () => {
    it("duas inicializações simultâneas convergem sem erro", async () => {
      const { db } = await import("@workspace/db");
      const { seedIfEmpty } = await import("./seed");

      const wide = await db.execute(sql`SELECT count(*)::int AS n FROM scenario_params`);
      expect(Number((wide.rows[0] as { n: number }).n)).toBeGreaterThan(0);

      await db.execute(sql`DROP TABLE IF EXISTS indicator_facts`);
      await db.execute(sql`DROP TABLE IF EXISTS dim_items`);

      await Promise.all([seedIfEmpty(), seedIfEmpty()]);

      const dims = await db.execute(sql`SELECT count(*)::int AS n FROM dim_items`);
      const facts = await db.execute(sql`SELECT count(*)::int AS n FROM indicator_facts`);
      expect(Number((dims.rows[0] as { n: number }).n)).toBeGreaterThan(0);
      expect(Number((facts.rows[0] as { n: number }).n)).toBeGreaterThan(0);
    }, 60_000);
  },
);
