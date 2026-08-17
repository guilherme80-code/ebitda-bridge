/**
 * Modelo dimensional dos indicadores (espelha o modelo SAC / Databricks).
 *
 * Fonte canônica no banco: `dim_items` (dimensão de itens com propriedades
 * secao/moeda/atributo/grupo/ordem) + `indicator_facts` (fato enxuta:
 * cenário mensal × item × indicador → valor).
 *
 * O cálculo do bridge continua consumindo as formas "largas"
 * (ScenarioParams, SalesFact, ...): este módulo as reconstrói na leitura.
 * Também converte bancos antigos (tabelas largas) para o modelo dimensional.
 */
import type {
  DimItem,
  IndicatorFact,
  InsertDimItem,
  InsertIndicatorFact,
  ScenarioParams,
  SalesFact,
  FixedCostFact,
  InputPriceFact,
  MiscFact,
} from "@workspace/db";
import type { RawScenarioData } from "./bridge-calc";

export const PARAM_INDICADORES: Record<string, keyof Omit<ScenarioParams, "scenarioId">> = {
  cambio_brl_usd: "fxRate",
  cambio_custo_fixo_brl_usd: "fcFxRate",
  aco_bruto_kt: "crudeSteelKt",
  ebitda_kusd: "ebitdaKusd",
  participacao_custo_interno: "dmCostShare",
};

export const ATRIBUTO_TO_DRIVER: Record<string, string> = {
  consumo: "usage",
  outros: "others",
  variacao_estoque: "stock_variation",
};
const DRIVER_TO_ATRIBUTO: Record<string, string> = Object.fromEntries(
  Object.entries(ATRIBUTO_TO_DRIVER).map(([a, d]) => [d, a]),
);

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

type FactRow = Pick<IndicatorFact, "scenarioId" | "item" | "indicador" | "valor">;

/**
 * Reconstrói as formas largas de um conjunto de cenários a partir da
 * dimensão + fato. Dados inconsistentes (item fora da dimensão, produto sem
 * um dos três indicadores de venda...) interrompem com erro explícito — o
 * importador e o seed garantem a integridade; nunca completamos em silêncio.
 */
export function buildRawScenarios(
  dims: DimItem[],
  facts: FactRow[],
): Map<string, RawScenarioData> {
  const dimByItem = new Map(dims.map((d) => [d.item, d]));
  const byScenario = new Map<string, FactRow[]>();
  for (const f of facts) {
    const list = byScenario.get(f.scenarioId) ?? [];
    list.push(f);
    byScenario.set(f.scenarioId, list);
  }

  const out = new Map<string, RawScenarioData>();
  for (const [scenarioId, rows] of byScenario) {
    // valores por item → indicador
    const perItem = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const dim = dimByItem.get(r.item);
      if (!dim) {
        throw new Error(
          `Fato de indicadores referencia item fora da dimensão: "${r.item}" (cenário ${scenarioId})`,
        );
      }
      const vals = perItem.get(r.item) ?? new Map<string, number>();
      vals.set(r.indicador, r.valor);
      perItem.set(r.item, vals);
    }

    const params: Partial<Record<keyof Omit<ScenarioParams, "scenarioId">, number>> = {};
    const sales: SalesFact[] = [];
    const fixed: FixedCostFact[] = [];
    const inputs: InputPriceFact[] = [];
    const misc: MiscFact[] = [];
    const exigir = (vals: Map<string, number>, ind: string, item: string): number => {
      const v = vals.get(ind);
      if (v === undefined) {
        throw new Error(
          `Item "${item}" sem o indicador ${ind} no cenário ${scenarioId}`,
        );
      }
      return v;
    };

    // percorre na ordem da dimensão (ordem de exibição)
    const itemsOrdered = [...perItem.keys()].sort(
      (a, b) => dimByItem.get(a)!.sortOrder - dimByItem.get(b)!.sortOrder,
    );
    for (const item of itemsOrdered) {
      const dim = dimByItem.get(item)!;
      const vals = perItem.get(item)!;
      switch (dim.secao) {
        case "Parametros": {
          for (const [ind, field] of Object.entries(PARAM_INDICADORES)) {
            params[field] = exigir(vals, ind, item);
          }
          break;
        }
        case "Vendas": {
          sales.push({
            id: 0,
            scenarioId,
            productKey: slug(item),
            label: item,
            groupLabel: dim.grupo,
            currency: dim.moeda ?? "USD",
            domestic: dim.atributo === "interno",
            qtyKt: exigir(vals, "quantidade_kt", item),
            amountKusd: exigir(vals, "montante_kusd", item),
            varCostKusd: exigir(vals, "custo_variavel_kusd", item),
            sortOrder: dim.sortOrder,
          });
          break;
        }
        case "CustoFixo": {
          fixed.push({
            id: 0,
            scenarioId,
            category: item,
            groupLabel: dim.grupo,
            amountKusd: exigir(vals, "montante_kusd", item),
            usdDenominated: dim.moeda === "USD",
            sortOrder: dim.sortOrder,
          });
          break;
        }
        case "Insumos": {
          const precificado = vals.has("preco_usd_t");
          inputs.push({
            id: 0,
            scenarioId,
            item,
            groupLabel: dim.grupo,
            unitPriceUsd: precificado ? exigir(vals, "preco_usd_t", item) : null,
            yieldFactor: precificado ? exigir(vals, "fator_rendimento", item) : null,
            amountKusd: precificado ? null : exigir(vals, "montante_kusd", item),
            sortOrder: dim.sortOrder,
          });
          break;
        }
        case "Ajustes": {
          const driver = ATRIBUTO_TO_DRIVER[dim.atributo ?? ""];
          if (!driver) {
            throw new Error(
              `Ajuste "${item}" sem atributo válido na dimensão (recebido: "${dim.atributo ?? ""}")`,
            );
          }
          misc.push({
            id: 0,
            scenarioId,
            driver,
            label: item,
            groupLabel: dim.grupo,
            amountKusd: exigir(vals, "montante_kusd", item),
            sortOrder: dim.sortOrder,
          });
          break;
        }
        default:
          throw new Error(`Seção desconhecida na dimensão: "${dim.secao}" (item "${item}")`);
      }
    }

    const faltando = Object.values(PARAM_INDICADORES).filter((f) => params[f] === undefined);
    if (faltando.length > 0) continue; // cenário sem parâmetros: sem dados completos
    out.set(scenarioId, {
      params: { scenarioId, ...(params as Record<string, number>) } as ScenarioParams,
      sales,
      fixed,
      inputs,
      misc,
    });
  }
  return out;
}

/** Cenários "com dados": parâmetros completos E pelo menos um produto de
 *  vendas (mesma regra do modelo antigo). */
export function scenariosWithData(raw: Map<string, RawScenarioData>): Set<string> {
  const out = new Set<string>();
  for (const [id, r] of raw) if (r.sales.length > 0) out.add(id);
  return out;
}

export type WideData = {
  params: ScenarioParams[];
  sales: SalesFact[];
  fixed: FixedCostFact[];
  inputs: InputPriceFact[];
  misc: MiscFact[];
};

/**
 * Converte as tabelas largas (modelo antigo) para dimensão + fato.
 * Usado uma única vez por banco, no upgrade (dados importados preservados).
 * Propriedades inconsistentes entre cenários interrompem com erro.
 */
export function convertWideToDimensional(wide: WideData): {
  dims: InsertDimItem[];
  facts: InsertIndicatorFact[];
} {
  const dims = new Map<string, InsertDimItem>();
  const facts: InsertIndicatorFact[] = [];
  let ordem = 0;
  const registrarDim = (d: Omit<InsertDimItem, "sortOrder">): void => {
    const prev = dims.get(d.item);
    if (!prev) {
      dims.set(d.item, { ...d, sortOrder: ordem++ });
      return;
    }
    const assina = (x: Omit<InsertDimItem, "sortOrder">) =>
      `${x.secao}|${x.moeda ?? ""}|${x.atributo ?? ""}|${x.grupo ?? ""}`;
    if (assina(prev) !== assina(d)) {
      throw new Error(
        `Conversão para o modelo dimensional: item "${d.item}" com propriedades ` +
          `inconsistentes entre cenários (${assina(prev)} ≠ ${assina(d)})`,
      );
    }
  };

  registrarDim({ item: "Global", secao: "Parametros", moeda: null, atributo: null, grupo: null });
  for (const p of wide.params) {
    for (const [ind, field] of Object.entries(PARAM_INDICADORES)) {
      facts.push({ scenarioId: p.scenarioId, item: "Global", indicador: ind, valor: p[field] });
    }
  }
  const ordenado = <T extends { sortOrder: number }>(rows: T[]) =>
    [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const s of ordenado(wide.sales)) {
    registrarDim({
      item: s.label,
      secao: "Vendas",
      moeda: s.currency,
      atributo: s.domestic ? "interno" : "externo",
      grupo: s.groupLabel,
    });
    facts.push(
      { scenarioId: s.scenarioId, item: s.label, indicador: "quantidade_kt", valor: s.qtyKt },
      { scenarioId: s.scenarioId, item: s.label, indicador: "montante_kusd", valor: s.amountKusd },
      { scenarioId: s.scenarioId, item: s.label, indicador: "custo_variavel_kusd", valor: s.varCostKusd },
    );
  }
  for (const f of ordenado(wide.fixed)) {
    registrarDim({
      item: f.category,
      secao: "CustoFixo",
      moeda: f.usdDenominated ? "USD" : "BRL",
      atributo: null,
      grupo: f.groupLabel,
    });
    facts.push({
      scenarioId: f.scenarioId,
      item: f.category,
      indicador: "montante_kusd",
      valor: f.amountKusd,
    });
  }
  for (const i of ordenado(wide.inputs)) {
    registrarDim({ item: i.item, secao: "Insumos", moeda: null, atributo: null, grupo: i.groupLabel });
    if (i.unitPriceUsd != null) {
      facts.push(
        { scenarioId: i.scenarioId, item: i.item, indicador: "preco_usd_t", valor: i.unitPriceUsd },
        { scenarioId: i.scenarioId, item: i.item, indicador: "fator_rendimento", valor: i.yieldFactor ?? 0 },
      );
    } else if (i.amountKusd != null) {
      facts.push({
        scenarioId: i.scenarioId,
        item: i.item,
        indicador: "montante_kusd",
        valor: i.amountKusd,
      });
    } else {
      throw new Error(
        `Conversão para o modelo dimensional: insumo "${i.item}" sem preço nem montante (cenário ${i.scenarioId})`,
      );
    }
  }
  for (const m of ordenado(wide.misc)) {
    const atributo = DRIVER_TO_ATRIBUTO[m.driver];
    if (!atributo) {
      throw new Error(
        `Conversão para o modelo dimensional: ajuste "${m.label}" com driver desconhecido "${m.driver}"`,
      );
    }
    registrarDim({ item: m.label, secao: "Ajustes", moeda: null, atributo, grupo: m.groupLabel });
    facts.push({
      scenarioId: m.scenarioId,
      item: m.label,
      indicador: "montante_kusd",
      valor: m.amountKusd,
    });
  }
  return { dims: [...dims.values()], facts };
}
