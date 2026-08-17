import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";

/**
 * Testes de integração da inicialização (upgrade de bancos antigos):
 *  1. duas instâncias simultâneas contra uma base vazia que ainda carrega
 *     tabelas legadas (banco recém-publicado de versão antiga) — ambas devem
 *     terminar, o modelo dimensional fica completo e as legadas caem;
 *  2. conversão real de explicações legadas (par mensal) para o formato por
 *     versão, seguida do DROP;
 *  3. explicações legadas SEM par mensal abortam a subida sem derrubar nada.
 *
 * Executa DDL destrutiva e re-semeia o banco apontado por DATABASE_URL a
 * partir do seed bundled, por isso só roda quando RUN_DB_INT_TESTS=1:
 *   RUN_DB_INT_TESTS=1 pnpm --filter @workspace/api-server test seed.int
 */

const LEGACY_MARKET_DDL = `
  CREATE TABLE IF NOT EXISTS market_explanations (
    id serial PRIMARY KEY,
    source_id text NOT NULL,
    target_id text NOT NULL,
    title text NOT NULL,
    unit_label text NOT NULL DEFAULT 'Price $/t',
    sort_order integer NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS market_explanation_lines (
    id serial PRIMARY KEY,
    explanation_id integer NOT NULL REFERENCES market_explanations(id) ON DELETE CASCADE,
    label text NOT NULL,
    source_value double precision,
    target_value double precision,
    var_value double precision,
    volume_kt double precision,
    impact_musd double precision NOT NULL,
    sort_order integer NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS market_explanation_items (
    id serial PRIMARY KEY,
    explanation_id integer NOT NULL REFERENCES market_explanations(id) ON DELETE CASCADE,
    item text NOT NULL
  );
`;

describe.runIf(process.env["RUN_DB_INT_TESTS"] === "1")(
  "seed — upgrade de base legada e drop das tabelas",
  () => {
    it("duas inicializações simultâneas convergem e derrubam as legadas", async () => {
      const { db } = await import("@workspace/db");
      const { seedIfEmpty } = await import("./seed");

      // Base "recém-publicada de versão antiga": tabelas legadas presentes
      // (vazias) e nenhum dado.
      await db.execute(
        sql.raw(`CREATE TABLE IF NOT EXISTS scenario_params (scenario_id text PRIMARY KEY)`),
      );
      await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS sales_facts (id serial PRIMARY KEY)`));
      await db.execute(sql.raw(LEGACY_MARKET_DDL));
      await db.execute(sql`DROP TABLE IF EXISTS indicator_facts`);
      await db.execute(sql`DROP TABLE IF EXISTS dim_items`);
      await db.execute(sql`DELETE FROM market_indicator_items`);
      await db.execute(sql`DELETE FROM market_indicator_values`);
      await db.execute(sql`DELETE FROM market_indicator_lines`);
      await db.execute(sql`DELETE FROM market_indicators`);
      await db.execute(sql`DELETE FROM scenarios`);

      await Promise.all([seedIfEmpty(), seedIfEmpty()]);

      const dims = await db.execute(sql`SELECT count(*)::int AS n FROM dim_items`);
      const facts = await db.execute(sql`SELECT count(*)::int AS n FROM indicator_facts`);
      expect(Number((dims.rows[0] as { n: number }).n)).toBeGreaterThan(0);
      expect(Number((facts.rows[0] as { n: number }).n)).toBeGreaterThan(0);

      for (const table of ["scenario_params", "sales_facts", "market_explanations"]) {
        const gone = await db.execute(
          sql`SELECT to_regclass(${"public." + table}) IS NULL AS gone`,
        );
        expect((gone.rows[0] as { gone: boolean }).gone).toBe(true);
      }
    }, 60_000);

    it("converte explicações legadas mensais e derruba as tabelas", async () => {
      const { db } = await import("@workspace/db");
      const { seedIfEmpty } = await import("./seed");

      await db.execute(sql.raw(LEGACY_MARKET_DDL));
      await db.execute(sql`
        INSERT INTO market_explanations (source_id, target_id, title, unit_label, sort_order)
        VALUES ('fy26_m01_budget', 'fy26_m01_mrf7', 'Iron Ores INT', 'Price $/t', 1)
      `);
      await db.execute(sql`
        INSERT INTO market_explanation_lines
          (explanation_id, label, source_value, target_value, var_value, volume_kt, impact_musd, sort_order)
        SELECT id, 'Iron ore 62%', 100, 110, 10, 500, -5, 1 FROM market_explanations
      `);
      await db.execute(sql`
        INSERT INTO market_explanation_items (explanation_id, item)
        SELECT id, 'Fines' FROM market_explanations
      `);
      await db.execute(sql`DELETE FROM market_indicator_items`);
      await db.execute(sql`DELETE FROM market_indicator_values`);
      await db.execute(sql`DELETE FROM market_indicator_lines`);
      await db.execute(sql`DELETE FROM market_indicators`);

      await seedIfEmpty();

      const conv = await db.execute(
        sql`SELECT count(*)::int AS n FROM market_indicators WHERE title = 'Iron Ores INT'`,
      );
      expect(Number((conv.rows[0] as { n: number }).n)).toBe(1);
      const gone = await db.execute(
        sql`SELECT to_regclass('public.market_explanations') IS NULL AS gone`,
      );
      expect((gone.rows[0] as { gone: boolean }).gone).toBe(true);

      // Restaura os indicadores do seed bundled para os próximos testes.
      await db.execute(sql`DELETE FROM market_indicator_items`);
      await db.execute(sql`DELETE FROM market_indicator_values`);
      await db.execute(sql`DELETE FROM market_indicator_lines`);
      await db.execute(sql`DELETE FROM market_indicators`);
      await seedIfEmpty();
    }, 60_000);

    it("aborta sem derrubar quando só há pares FY/trimestre legados", async () => {
      const { db } = await import("@workspace/db");
      const { seedIfEmpty } = await import("./seed");

      await db.execute(sql.raw(LEGACY_MARKET_DDL));
      await db.execute(sql`
        INSERT INTO market_explanations (source_id, target_id, title)
        VALUES ('fy26_fy_budget', 'fy26_fy_mrf7', 'Iron Ores FY')
      `);
      await db.execute(sql`DELETE FROM market_indicator_items`);
      await db.execute(sql`DELETE FROM market_indicator_values`);
      await db.execute(sql`DELETE FROM market_indicator_lines`);
      await db.execute(sql`DELETE FROM market_indicators`);

      await expect(seedIfEmpty()).rejects.toThrow(/nenhum par é mensal/);
      const still = await db.execute(
        sql`SELECT to_regclass('public.market_explanations') IS NOT NULL AS present`,
      );
      expect((still.rows[0] as { present: boolean }).present).toBe(true);

      // Limpa o fixture e restaura os indicadores do seed bundled.
      await db.execute(sql`DROP TABLE IF EXISTS market_explanation_items`);
      await db.execute(sql`DROP TABLE IF EXISTS market_explanation_lines`);
      await db.execute(sql`DROP TABLE IF EXISTS market_explanations`);
      await seedIfEmpty();
    }, 60_000);
  },
);
