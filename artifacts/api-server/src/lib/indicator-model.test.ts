/**
 * Ida e volta do modelo dimensional com o seed real (que hoje só carrega as
 * seções dimensionais — as tabelas largas foram removidas do banco):
 * dim_items + indicator_facts são reconstruídos em formas largas
 * (buildRawScenarios, o caminho de leitura da API) e convertidos de volta
 * (convertWideToDimensional, o caminho de upgrade de bancos antigos) — o
 * resultado deve ser idêntico ao seed original, fato a fato.
 */
import { describe, it, expect } from "vitest";
import { buildRawScenarios, convertWideToDimensional } from "./indicator-model";
import type { DimItem } from "@workspace/db";
import seed from "../seed/bridge-seed.json";

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);

function dimsFromSeed(): DimItem[] {
  const s = seed as Record<string, unknown>;
  return ((s.dim_items as Row[]) ?? []).map((r) => ({
    item: String(r.item),
    secao: String(r.secao),
    moeda: r.moeda == null ? null : String(r.moeda),
    atributo: r.atributo == null ? null : String(r.atributo),
    grupo: r.grupo == null ? null : String(r.grupo),
    sortOrder: num(r.sort_order),
  }));
}

function factsFromSeed() {
  const s = seed as Record<string, unknown>;
  return ((s.indicator_facts as Row[]) ?? []).map((r) => ({
    scenarioId: String(r.scenario_id),
    item: String(r.item),
    indicador: String(r.indicador),
    valor: num(r.valor),
  }));
}

describe("modelo dimensional — ida e volta com o seed real", () => {
  it("buildRawScenarios + convertWideToDimensional reproduz o seed", () => {
    const seedDims = dimsFromSeed();
    const seedFacts = factsFromSeed();
    expect(seedDims.length).toBeGreaterThan(0);
    expect(seedFacts.length).toBeGreaterThan(0);

    const raw = buildRawScenarios(seedDims, seedFacts);
    expect(raw.size).toBeGreaterThan(0);

    const scenarios = [...raw.values()];
    const wide = {
      params: scenarios.map((d) => d.params),
      sales: scenarios.flatMap((d) => d.sales),
      fixed: scenarios.flatMap((d) => d.fixed),
      inputs: scenarios.flatMap((d) => d.inputs),
      misc: scenarios.flatMap((d) => d.misc),
    };
    const { dims, facts } = convertWideToDimensional(wide);

    // Dimensão: mesmos itens e propriedades do seed.
    expect(dims.length).toBe(seedDims.length);
    const byItem = new Map(dims.map((d) => [d.item, d]));
    for (const r of seedDims) {
      const d = byItem.get(r.item);
      expect(d, `item ${r.item} ausente na conversão`).toBeDefined();
      expect({
        secao: d!.secao,
        moeda: d!.moeda ?? null,
        atributo: d!.atributo ?? null,
        grupo: d!.grupo ?? null,
      }).toEqual({
        secao: r.secao,
        moeda: r.moeda,
        atributo: r.atributo,
        grupo: r.grupo,
      });
    }

    // Fato: mesmo conjunto cenário × item × indicador → valor.
    const key = (f: { scenarioId: string; item: string; indicador: string }) =>
      `${f.scenarioId}|${f.item}|${f.indicador}`;
    const original = new Map(seedFacts.map((f) => [key(f), f.valor]));
    expect(facts.length).toBe(seedFacts.length);
    for (const f of facts) {
      const v = original.get(key(f));
      expect(v, `fato inesperado na conversão: ${key(f)}`).toBeDefined();
      expect(f.valor).toBeCloseTo(v!, 9);
    }
  });
});
