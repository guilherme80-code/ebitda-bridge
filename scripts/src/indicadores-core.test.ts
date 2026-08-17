import { describe, it, expect } from "vitest";
import {
  validarItemDim,
  mesclarDimensao,
  ordenarDimensao,
  validarLinha,
  montarDados,
  type Rotulador,
} from "./indicadores-core";

const rotuloFato: Rotulador = (l) => `Fato ${l}`;
const rotuloDim: Rotulador = (l) => `Dim ${l}`;

const dimVendas = { item: "Fines", secao: "Vendas", moeda: "USD", atributo: "externo", grupo: "Minerais" };
const dimInsumo = { item: "Carvão", secao: "Insumos", moeda: null, atributo: "consumo", grupo: null };

function fato(extra: Record<string, unknown>) {
  return {
    registro: { versao: "BUDGET", periodo: "JAN26", item: "Fines", indicador: "quantidade_kt", valor: 10, ...extra },
    posicao: 2,
  };
}

describe("validarItemDim", () => {
  it("valida item com propriedades opcionais", () => {
    const d = validarItemDim({ ...dimVendas }, 2, rotuloDim);
    expect(d).toMatchObject(dimVendas);
  });
  it("rejeita secao desconhecida e item vazio apontando a linha", () => {
    expect(() => validarItemDim({ item: "X", secao: "Nada" }, 3, rotuloDim)).toThrow(/Dim 3.*secao desconhecida/);
    expect(() => validarItemDim({ item: "", secao: "Vendas" }, 4, rotuloDim)).toThrow(/Dim 4.*"item" vazia/);
  });
});

describe("mesclarDimensao", () => {
  const dims = [
    validarItemDim({ ...dimVendas }, 2, rotuloDim),
    validarItemDim({ ...dimInsumo }, 3, rotuloDim),
  ];

  it("propaga as propriedades da dimensão para a fato enxuta", () => {
    const [m] = mesclarDimensao([fato({})], dims, rotuloFato, rotuloDim);
    expect(m.registro.secao).toBe("Vendas");
    expect(m.registro.moeda).toBe("USD");
    expect(m.registro.grupo).toBe("Minerais");
    // resultado validável pelo caminho normal
    const r = validarLinha(m.registro, m.posicao, rotuloFato);
    expect(r.secao).toBe("Vendas");
  });

  it("aceita propriedades repetidas na fato quando iguais à dimensão", () => {
    const [m] = mesclarDimensao([fato({ secao: "Vendas", moeda: "USD" })], dims, rotuloFato, rotuloDim);
    expect(m.registro.secao).toBe("Vendas");
  });

  it("rejeita conflito entre fato e dimensão", () => {
    expect(() =>
      mesclarDimensao([fato({ secao: "Insumos" })], dims, rotuloFato, rotuloDim),
    ).toThrow(/Fato 2.*"secao".*conflita com a dimensão/);
    expect(() =>
      mesclarDimensao([fato({ moeda: "BRL" })], dims, rotuloFato, rotuloDim),
    ).toThrow(/Fato 2.*"moeda".*conflita/);
  });

  it("rejeita item da fato fora da dimensão", () => {
    expect(() =>
      mesclarDimensao([fato({ item: "Pellets" })], dims, rotuloFato, rotuloDim),
    ).toThrow(/Fato 2.*"Pellets" não consta na dimensão/);
  });

  it("sort_order segue a ordem da dimensão, não a primeira aparição na fato", () => {
    // Cenário completo mínimo (Parametros) + duas vendas em ordem invertida
    // em relação à dimensão; "Pellets" ainda entra só num segundo mês.
    const dimensao = [
      validarItemDim({ item: "Global", secao: "Parametros" }, 2, rotuloDim),
      validarItemDim({ item: "Pellets", secao: "Vendas", moeda: "USD", atributo: "externo" }, 3, rotuloDim),
      validarItemDim({ ...dimVendas }, 4, rotuloDim), // Fines depois de Pellets
    ];
    const params = (periodo: string, base: number) =>
      ["cambio_brl_usd", "cambio_custo_fixo_brl_usd", "aco_bruto_kt", "ebitda_kusd", "participacao_custo_interno"].map(
        (indicador, i) => ({
          registro: { versao: "BUDGET", periodo, item: "Global", indicador, valor: base + i },
          posicao: 100 + i,
        }),
      );
    const venda = (periodo: string, item: string, pos: number) =>
      ["quantidade_kt", "montante_kusd", "custo_variavel_kusd"].map((indicador, i) => ({
        registro: { versao: "BUDGET", periodo, item, indicador, valor: 10 + i },
        posicao: pos + i,
      }));
    const fatoRows = [
      ...params("JAN26", 1),
      ...venda("JAN26", "Fines", 200), // Fines aparece primeiro na fato
      ...params("FEB26", 1),
      ...venda("FEB26", "Fines", 210),
      ...venda("FEB26", "Pellets", 220), // Pellets só a partir de FEB
    ];
    const merged = mesclarDimensao(fatoRows, dimensao, rotuloFato, rotuloDim);
    const registros = merged.map(({ registro, posicao }) => validarLinha(registro, posicao, rotuloFato));
    const dados = montarDados(registros, rotuloFato, dimensao);
    const ordem = [...dados.dims].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((d) => d.item);
    expect(ordem).toEqual(["Global", "Pellets", "Fines"]);
  });

  it("ordenarDimensao fixa a ordem pelo sort_order mesmo com retorno embaralhado", () => {
    const rows = [
      { registro: { item: "C", secao: "Vendas", sort_order: 2 }, posicao: 1 },
      { registro: { item: "A", secao: "Parametros", sort_order: 0 }, posicao: 2 },
      { registro: { item: "B", secao: "Vendas", sort_order: 1 }, posicao: 3 },
    ];
    const ordenadas = ordenarDimensao(rows, rotuloDim, true);
    expect(ordenadas.map((r) => r.registro.item)).toEqual(["A", "B", "C"]);
  });

  it("ordenarDimensao exige sort_order quando obrigatório (Databricks) e valida a coluna", () => {
    const sem = [{ registro: { item: "A", secao: "Vendas" }, posicao: 1 }];
    expect(() => ordenarDimensao(sem, rotuloDim, true)).toThrow(/"sort_order" ausente/);
    // Excel: opcional — sem a coluna, mantém a ordem das linhas
    expect(ordenarDimensao(sem, rotuloDim, false)).toEqual(sem);
    expect(() =>
      ordenarDimensao(
        [
          { registro: { item: "A", sort_order: 0 }, posicao: 1 },
          { registro: { item: "B", sort_order: null }, posicao: 2 },
        ],
        rotuloDim,
        false,
      ),
    ).toThrow(/"sort_order" vazia/);
    expect(() =>
      ordenarDimensao(
        [
          { registro: { item: "A", sort_order: 0 }, posicao: 1 },
          { registro: { item: "B", sort_order: 0 }, posicao: 2 },
        ],
        rotuloDim,
        false,
      ),
    ).toThrow(/"sort_order" duplicada/);
    expect(() =>
      ordenarDimensao([{ registro: { item: "A", sort_order: "x" }, posicao: 1 }], rotuloDim, false),
    ).toThrow(/"sort_order" não numérica/);
  });

  it("preserva membro da dimensão sem nenhum valor na fato (round-trip fiel)", () => {
    const dimensao = [
      validarItemDim({ item: "Global", secao: "Parametros" }, 2, rotuloDim),
      validarItemDim({ ...dimVendas }, 3, rotuloDim),
      // Membro ainda sem dados em nenhum cenário — deve ser gravado assim mesmo
      validarItemDim(
        { item: "Slabs", secao: "Vendas", moeda: "USD", atributo: "externo", grupo: "Blacks" },
        4,
        rotuloDim,
      ),
    ];
    const params = ["cambio_brl_usd", "cambio_custo_fixo_brl_usd", "aco_bruto_kt", "ebitda_kusd", "participacao_custo_interno"].map(
      (indicador, i) => ({
        registro: { versao: "BUDGET", periodo: "JAN26", item: "Global", indicador, valor: 1 + i },
        posicao: 100 + i,
      }),
    );
    const vendas = ["quantidade_kt", "montante_kusd", "custo_variavel_kusd"].map((indicador, i) => ({
      registro: { versao: "BUDGET", periodo: "JAN26", item: "Fines", indicador, valor: 10 + i },
      posicao: 200 + i,
    }));
    const merged = mesclarDimensao([...params, ...vendas], dimensao, rotuloFato, rotuloDim);
    const registros = merged.map(({ registro, posicao }) => validarLinha(registro, posicao, rotuloFato));
    const dados = montarDados(registros, rotuloFato, dimensao);
    const slabs = dados.dims.find((d) => d.item === "Slabs");
    expect(slabs).toMatchObject({ secao: "Vendas", grupo: "Blacks", sortOrder: 2 });
    expect(dados.dims.map((d) => d.item)).toEqual(["Global", "Fines", "Slabs"]);
    expect(dados.facts.some((f) => f.item === "Slabs")).toBe(false);
  });

  it("rejeita item duplicado na dimensão", () => {
    const dup = [...dims, validarItemDim({ item: "Fines", secao: "Vendas" }, 9, rotuloDim)];
    expect(() => mesclarDimensao([fato({})], dup, rotuloFato, rotuloDim)).toThrow(
      /Dim 9.*item duplicado na dimensão: "Fines"/,
    );
  });
});
