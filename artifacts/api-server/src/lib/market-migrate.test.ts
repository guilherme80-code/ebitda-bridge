import { describe, it, expect } from "vitest";
import { convertLegacyMarketExplanations } from "./market-migrate";
import type {
  MarketExplanation,
  MarketExplanationLine,
  MarketExplanationItem,
} from "@workspace/db";

let headId = 0;
function head(sourceId: string, targetId: string, title = "Iron Ores"): MarketExplanation {
  return { id: ++headId, sourceId, targetId, title, unitLabel: "Price $/t", sortOrder: 0 };
}
let lineId = 0;
function legacyLine(
  explanationId: number,
  label: string,
  extra: Partial<MarketExplanationLine> = {},
): MarketExplanationLine {
  return {
    id: ++lineId,
    explanationId,
    label,
    sourceValue: null,
    targetValue: null,
    varValue: null,
    volumeKt: null,
    impactMusd: 0,
    sortOrder: 0,
    ...extra,
  };
}
const item = (explanationId: number, it: string): MarketExplanationItem => ({
  id: 1,
  explanationId,
  item: it,
});

describe("convertLegacyMarketExplanations", () => {
  it("converte linha de preço (custo) preservando valores, kt e itens", () => {
    const h = head("fy26_m01_budget", "fy26_m01_mrf7");
    const out = convertLegacyMarketExplanations(
      [h],
      [
        legacyLine(h.id, "Pellet premium", {
          sourceValue: 30,
          targetValue: 37,
          varValue: 7,
          volumeKt: 2,
          impactMusd: -14,
        }),
      ],
      [item(h.id, "Fines")],
    );
    expect(out).toHaveLength(1);
    const l = out[0].lines[0];
    expect(l.kind).toBe("price");
    expect(l.direction).toBe(-1);
    expect(l.values).toEqual([
      { scenarioId: "fy26_m01_budget", value: 30, volumeKt: 2 },
      { scenarioId: "fy26_m01_mrf7", value: 37, volumeKt: 2 },
    ]);
    expect(out[0].items).toEqual(["Fines"]);
  });

  it("infere direção +1 (benefício) e a inferência vence o padrão de meses com variação zero", () => {
    const h1 = head("fy26_m01_budget", "fy26_m01_mrf7");
    const h2 = head("fy26_m02_budget", "fy26_m02_mrf7");
    const out = convertLegacyMarketExplanations(
      [h1, h2],
      [
        // mês 1: variação zero — direção cai no padrão -1
        legacyLine(h1.id, "Netback freight", {
          sourceValue: 16,
          targetValue: 16,
          varValue: 0,
          volumeKt: 1,
          impactMusd: 0,
        }),
        // mês 2: benefício — inferência deve corrigir a linha inteira para +1
        legacyLine(h2.id, "Netback freight", {
          sourceValue: 16,
          targetValue: 20,
          varValue: 4,
          volumeKt: 1,
          impactMusd: 4,
        }),
      ],
      [],
    );
    expect(out[0].lines[0].direction).toBe(1);
  });

  it("aborta quando dois pares inferem direções opostas para a mesma linha", () => {
    const h1 = head("fy26_m01_budget", "fy26_m01_mrf7");
    const h2 = head("fy26_m02_budget", "fy26_m02_mrf7");
    expect(() =>
      convertLegacyMarketExplanations(
        [h1, h2],
        [
          legacyLine(h1.id, "A", { sourceValue: 10, targetValue: 12, volumeKt: 1, impactMusd: -2 }),
          legacyLine(h2.id, "A", { sourceValue: 10, targetValue: 12, volumeKt: 1, impactMusd: 2 }),
        ],
        [],
      ),
    ).toThrow(/direção\s+inconsistente/);
  });

  it("converte montante como origem 0 / destino -impacto e preserva o impacto", () => {
    const h = head("fy26_m01_budget", "fy26_m01_mrf7");
    const out = convertLegacyMarketExplanations(
      [h],
      [legacyLine(h.id, "Forex (contract)", { impactMusd: -6 })],
      [],
    );
    const l = out[0].lines[0];
    expect(l.kind).toBe("amount");
    expect(l.direction).toBe(-1);
    expect(l.values).toEqual([
      { scenarioId: "fy26_m01_budget", value: 0, volumeKt: null },
      { scenarioId: "fy26_m01_mrf7", value: 6, volumeKt: null },
    ]);
  });

  it("aborta em pares de montante encadeados não representáveis por níveis", () => {
    // budget→mrf6 (impacto -6) grava mrf6=6; mrf6→mrf7 quer mrf6=0 → conflito.
    const h1 = head("fy26_m01_budget", "fy26_m01_mrf6");
    const h2 = head("fy26_m01_mrf6", "fy26_m01_mrf7");
    expect(() =>
      convertLegacyMarketExplanations(
        [h1, h2],
        [
          legacyLine(h1.id, "Forex (contract)", { impactMusd: -6 }),
          legacyLine(h2.id, "Forex (contract)", { impactMusd: -2 }),
        ],
        [],
      ),
    ).toThrow(/conflitantes|não é representável/);
  });

  it("aborta quando valores de preço conflitam para o mesmo cenário", () => {
    const h1 = head("fy26_m01_budget", "fy26_m01_mrf6");
    const h2 = head("fy26_m01_budget", "fy26_m01_mrf7");
    expect(() =>
      convertLegacyMarketExplanations(
        [h1, h2],
        [
          legacyLine(h1.id, "A", { sourceValue: 10, targetValue: 11, volumeKt: 1, impactMusd: -1 }),
          legacyLine(h2.id, "A", { sourceValue: 12, targetValue: 13, volumeKt: 1, impactMusd: -1 }),
        ],
        [],
      ),
    ).toThrow(/valores conflitantes/);
  });
});
