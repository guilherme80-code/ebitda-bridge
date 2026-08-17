/**
 * Loader de cenários a partir do seed real (src/seed/bridge-seed.json),
 * compartilhado pelos testes (bridge-calc.test.ts, simulate.test.ts).
 * Como o seed é o mesmo usado para popular o banco, os testes acompanham
 * automaticamente o formato dos dados de produção.
 *
 * Usa as seções dimensionais (dim_items + indicator_facts) — a fonte
 * canônica — reconstruindo as formas largas pelo mesmo caminho da API
 * (buildRawScenarios).
 */
import type { RawScenarioData } from "./bridge-calc";
import { aggregateMonths } from "./aggregate";
import { buildRawScenarios } from "./indicator-model";
import type { DimItem } from "@workspace/db";
import seed from "../seed/bridge-seed.json";

/**
 * Carrega um cenário derivado (FY/trimestre) consolidando os meses da versão
 * a partir do seed mensal — o mesmo caminho da API (aggregateMonths).
 * Ex.: loadDerived("fy26_fy_budget") soma jan..dez do Budget FY26.
 */
export function loadDerived(id: string): { data: RawScenarioData; monthIds: string[] } {
  const m = id.match(/^fy(\d{2})_(fy|q[1-4])_(.+)$/);
  if (!m) throw new Error(`id derivado inválido: ${id}`);
  const [, yy, per, vSlug] = m;
  const months =
    per === "fy"
      ? Array.from({ length: 12 }, (_, i) => i + 1)
      : Array.from({ length: 3 }, (_, i) => (Number(per[1]) - 1) * 3 + i + 1);
  const monthIds = months.map(
    (mm) => `fy${yy}_m${String(mm).padStart(2, "0")}_${vSlug}`,
  );
  return { data: aggregateMonths(id, monthIds.map(loadScenario)), monthIds };
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);

let cache: Map<string, RawScenarioData> | undefined;

function scenarios(): Map<string, RawScenarioData> {
  if (cache) return cache;
  const raw = seed as Record<string, unknown>;
  const dims: DimItem[] = ((raw.dim_items as Row[]) ?? []).map((r) => ({
    item: String(r.item),
    secao: String(r.secao),
    moeda: r.moeda == null ? null : String(r.moeda),
    atributo: r.atributo == null ? null : String(r.atributo),
    grupo: r.grupo == null ? null : String(r.grupo),
    sortOrder: num(r.sort_order),
  }));
  const facts = ((raw.indicator_facts as Row[]) ?? []).map((r) => ({
    scenarioId: String(r.scenario_id),
    item: String(r.item),
    indicador: String(r.indicador),
    valor: num(r.valor),
  }));
  cache = buildRawScenarios(dims, facts);
  return cache;
}

/** Monta RawScenarioData a partir das seções dimensionais do seed. */
export function loadScenario(id: string): RawScenarioData {
  const data = scenarios().get(id);
  if (!data) throw new Error(`cenário ${id} ausente no seed`);
  return data;
}
