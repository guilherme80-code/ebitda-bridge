import { describe, it, expect } from "vitest";
import {
  scenarioIdDe,
  validarLinhaValor,
  validarLinhaItem,
  validarLinhaDim,
  mesclarDimensaoLinhas,
  montarDadosMercado,
  type Rotulador,
} from "./market-explanations-core";

const rotulo: Rotulador = (l) => `Linha ${l}`;

const base = {
  versao: "BUDGET",
  periodo: "JAN26",
  explicacao: "Iron Ores",
  unidade: "Price $/t",
};

function linha(extra: Record<string, unknown>) {
  return { ...base, ...extra };
}

describe("scenarioIdDe", () => {
  it("deriva ids nas três granularidades do painel", () => {
    expect(scenarioIdDe("BUDGET", "FY26", 2, rotulo)).toBe("fy26_fy_budget");
    expect(scenarioIdDe("MRF7", "Q126", 2, rotulo)).toBe("fy26_q1_mrf7");
    expect(scenarioIdDe("MRF3", "JAN26", 2, rotulo)).toBe("fy26_m01_mrf3");
    expect(scenarioIdDe("ACTUAL", "DEC26", 2, rotulo)).toBe("fy26_m12_actual");
  });
  it("normaliza MRF07 para MRF7 e aceita minúsculas", () => {
    expect(scenarioIdDe("MRF07", "FY26", 2, rotulo)).toBe("fy26_fy_mrf7");
    expect(scenarioIdDe("budget", "fy26", 2, rotulo)).toBe("fy26_fy_budget");
  });
  it("rejeita versão e período desconhecidos apontando a linha", () => {
    expect(() => scenarioIdDe("MRF9", "FY26", 5, rotulo)).toThrow(/Linha 5.*versao desconhecida/);
    expect(() => scenarioIdDe("BUDGET", "S126", 7, rotulo)).toThrow(/Linha 7.*periodo desconhecido/);
  });

  it("aceita YYYYMM (padrão SAC) e rejeita mês/ano inválidos", () => {
    expect(scenarioIdDe("MRF3", "202601", 2, rotulo)).toBe("fy26_m01_mrf3");
    expect(scenarioIdDe("ACTUAL", "202612", 2, rotulo)).toBe("fy26_m12_actual");
    expect(scenarioIdDe("BUDGET", "202601", 2, rotulo)).toBe(scenarioIdDe("BUDGET", "JAN26", 2, rotulo));
    expect(() => scenarioIdDe("BUDGET", "202613", 4, rotulo)).toThrow(/mês inválido/);
    expect(() => scenarioIdDe("BUDGET", "190001", 4, rotulo)).toThrow(/ano fora do esperado/);
  });
});

describe("validarLinhaValor — formato por versão", () => {
  it("aceita linha de preço com kt e aplica padrões (tipo preco, sentido -1)", () => {
    const r = validarLinhaValor(
      linha({ linha: "Pellet premium", valor: 30, kt: 5.486 }),
      2,
      rotulo,
    );
    expect(r.scenarioId).toBe("fy26_m01_budget");
    expect(r.tipo).toBe("price");
    expect(r.sentido).toBe(-1);
    expect(r.valor).toBe(30);
    expect(r.kt).toBe(5.486);
  });
  it("aceita tipo valor (montante MUSD) e sentido +1", () => {
    const r = validarLinhaValor(
      linha({ linha: "Netback freight", valor: 16, tipo: "preco", sentido: 1 }),
      2,
      rotulo,
    );
    expect(r.sentido).toBe(1);
    const m = validarLinhaValor(
      linha({ linha: "Forex (contract)", valor: 0.5, tipo: "valor" }),
      3,
      rotulo,
    );
    expect(m.tipo).toBe("amount");
    expect(m.kt).toBeNull();
  });
  it("rejeita valor não numérico, coluna vazia, tipo e sentido inválidos", () => {
    expect(() =>
      validarLinhaValor(linha({ linha: "X", valor: "abc" }), 4, rotulo),
    ).toThrow(/Linha 4.*coluna "valor" não numérica/);
    expect(() =>
      validarLinhaValor(linha({ linha: "", valor: 1 }), 5, rotulo),
    ).toThrow(/Linha 5.*coluna "linha" vazia/);
    expect(() =>
      validarLinhaValor(linha({ linha: "X", valor: 1, tipo: "percentual" }), 6, rotulo),
    ).toThrow(/Linha 6.*coluna "tipo" inválida/);
    expect(() =>
      validarLinhaValor(linha({ linha: "X", valor: 1, sentido: 2 }), 7, rotulo),
    ).toThrow(/Linha 7.*coluna "sentido" inválida/);
    expect(() =>
      validarLinhaValor(linha({ linha: "X", valor: 1, kt: "muito" }), 8, rotulo),
    ).toThrow(/Linha 8.*coluna "kt" não numérica/);
  });
  it("rejeita períodos FY/trimestre — armazenamento é mensal", () => {
    expect(() =>
      validarLinhaValor(linha({ periodo: "FY26", linha: "X", valor: 1 }), 9, rotulo),
    ).toThrow(/Linha 9.*periodo deve ser um mês/);
    expect(() =>
      validarLinhaValor(linha({ periodo: "Q126", linha: "X", valor: 1 }), 10, rotulo),
    ).toThrow(/Linha 10.*periodo deve ser um mês/);
  });
});

describe("montarDadosMercado", () => {
  const val = (extra: Record<string, unknown>, l: number) =>
    validarLinhaValor(linha(extra), l, rotulo);
  const item = (nome: string, l: number, extra: Record<string, unknown> = {}) =>
    validarLinhaItem(linha({ item: nome, ...extra }), l, rotulo);

  it("agrupa valores por explicação/linha e vincula itens", () => {
    const d = montarDadosMercado(
      [
        val({ linha: "Iron ore MB 62% (1m lag)", valor: 96, kt: 4.803 }, 2),
        val({ linha: "Iron ore MB 62% (1m lag)", valor: 103, kt: 4.9, versao: "MRF7" }, 3),
        val({ linha: "Forex (contract)", valor: 0.5, tipo: "valor" }, 4),
      ],
      [item("Fines", 2), item("Pellets", 3), item("Lumps", 4)],
      rotulo,
      rotulo,
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ title: "Iron Ores", unitLabel: "Price $/t" });
    expect(d[0].lines.map((l) => l.sortOrder)).toEqual([0, 1]);
    expect(d[0].lines[0].values.map((v) => v.scenarioId)).toEqual([
      "fy26_m01_budget",
      "fy26_m01_mrf7",
    ]);
    expect(d[0].items).toEqual(["Fines", "Pellets", "Lumps"]);
  });

  it("rejeita valor duplicado para a mesma linha/versão/mês", () => {
    expect(() =>
      montarDadosMercado(
        [val({ linha: "A", valor: 1 }, 2), val({ linha: "A", valor: 2 }, 3)],
        [],
        rotulo,
        rotulo,
      ),
    ).toThrow(/Linha 3.*valor duplicado.*linha "A".*fy26_m01_budget/);
  });

  it("rejeita tipo/sentido inconsistentes entre meses da mesma linha", () => {
    expect(() =>
      montarDadosMercado(
        [
          val({ linha: "A", valor: 1 }, 2),
          val({ linha: "A", valor: 2, versao: "MRF7", tipo: "valor" }, 3),
        ],
        [],
        rotulo,
        rotulo,
      ),
    ).toThrow(/Linha 3.*tipo\s+inconsistente/);
    expect(() =>
      montarDadosMercado(
        [
          val({ linha: "A", valor: 1 }, 2),
          val({ linha: "A", valor: 2, versao: "MRF7", sentido: 1 }, 3),
        ],
        [],
        rotulo,
        rotulo,
      ),
    ).toThrow(/Linha 3.*sentido\s+inconsistente/);
  });

  it("rejeita item para explicação inexistente e item duplicado", () => {
    expect(() =>
      montarDadosMercado(
        [val({ linha: "A", valor: 1 }, 2)],
        [item("Fines", 2, { explicacao: "Coking Coal" })],
        rotulo,
        rotulo,
      ),
    ).toThrow(/Linha 2.*explicação inexistente "Coking Coal"/);
    expect(() =>
      montarDadosMercado(
        [val({ linha: "A", valor: 1 }, 2)],
        [item("Fines", 2), item("Fines", 3)],
        rotulo,
        rotulo,
      ),
    ).toThrow(/Linha 3.*item "Fines" duplicado/);
  });

  it("rejeita unidade inconsistente na mesma explicação", () => {
    expect(() =>
      montarDadosMercado(
        [val({ linha: "A", valor: 1 }, 2), val({ linha: "B", valor: 1, unidade: "US$/t" }, 3)],
        [],
        rotulo,
        rotulo,
      ),
    ).toThrow(/Linha 3.*unidade inconsistente/);
  });
});

describe("dimensão de linhas (aba Linhas)", () => {
  const rotuloDim: Rotulador = (l) => `Dim ${l}`;
  const dims = [
    validarLinhaDim(
      { explicacao: "Iron Ores", linha: "MB 62%", tipo: "preco", sentido: -1, unidade: "Price $/t" },
      2,
      rotuloDim,
    ),
    validarLinhaDim({ explicacao: "Iron Ores", linha: "Netback", tipo: "valor", sentido: 1 }, 3, rotuloDim),
  ];
  const fatoRow = (extra: Record<string, unknown>, pos = 2) => ({
    registro: {
      versao: "BUDGET",
      periodo: "JAN26",
      explicacao: "Iron Ores",
      linha: "MB 62%",
      valor: 96,
      ...extra,
    },
    posicao: pos,
  });

  it("aplica padrões da dimensão (tipo preco, sentido -1) e propaga propriedades", () => {
    expect(dims[0]).toMatchObject({ tipo: "price", sentido: -1, unidade: "Price $/t" });
    const [m] = mesclarDimensaoLinhas([fatoRow({})], dims, rotulo, rotuloDim);
    expect(m.registro.explicacao).toBe("Iron Ores");
    const r = validarLinhaValor(m.registro, m.posicao, rotulo);
    expect(r.tipo).toBe("price");
    expect(r.sentido).toBe(-1);
    expect(r.unidade).toBe("Price $/t");
  });

  it("rejeita linha da fato fora da dimensão e conflitos de propriedade", () => {
    expect(() => mesclarDimensaoLinhas([fatoRow({ linha: "X" })], dims, rotulo, rotuloDim)).toThrow(
      /Linha 2.*"X" da explicação "Iron Ores" não consta na\s+dimensão/,
    );
    expect(() =>
      mesclarDimensaoLinhas([fatoRow({ tipo: "valor" })], dims, rotulo, rotuloDim),
    ).toThrow(/Linha 2.*tipo da fato.*conflita/);
    expect(() =>
      mesclarDimensaoLinhas([fatoRow({ sentido: 1 })], dims, rotulo, rotuloDim),
    ).toThrow(/Linha 2.*sentido da fato \(1\) conflita/);
    expect(() =>
      mesclarDimensaoLinhas([fatoRow({ explicacao: "Coking Coal" })], dims, rotulo, rotuloDim),
    ).toThrow(/Linha 2.*"MB 62%" da explicação "Coking Coal" não consta na\s+dimensão/);
    expect(() =>
      mesclarDimensaoLinhas([fatoRow({ explicacao: "" })], dims, rotulo, rotuloDim),
    ).toThrow(/Linha 2.*coluna "explicacao" vazia/);
  });

  it("rejeita o par explicação + linha duplicado na dimensão", () => {
    const dup = [
      ...dims,
      validarLinhaDim({ explicacao: "Iron Ores", linha: "MB 62%" }, 9, rotuloDim),
    ];
    expect(() => mesclarDimensaoLinhas([fatoRow({})], dup, rotulo, rotuloDim)).toThrow(
      /Dim 9.*linha duplicada na dimensão: "MB 62%" da explicação\s+"Iron Ores"/,
    );
  });

  it('rejeita "|" em explicação e em linha (reservado para a chave composta no SAC)', () => {
    expect(() => validarLinhaDim({ explicacao: "Iron|Ores", linha: "MB 62%" }, 9, rotuloDim)).toThrow(
      /"explicacao" não pode conter "\|"/,
    );
    expect(() => validarLinhaDim({ explicacao: "Iron Ores", linha: "MB|62%" }, 9, rotuloDim)).toThrow(
      /"linha" não pode conter "\|"/,
    );
  });

  it("aceita o mesmo rótulo de linha em explicações diferentes (chave composta)", () => {
    const compartilhado = [
      ...dims,
      validarLinhaDim(
        { explicacao: "Coking Coal", linha: "MB 62%", tipo: "preco", sentido: -1, unidade: "Price $/t" },
        9,
        rotuloDim,
      ),
    ];
    const fato = mesclarDimensaoLinhas(
      [fatoRow({}, 2), fatoRow({ explicacao: "Coking Coal", valor: 210 }, 3), fatoRow({ linha: "Netback", valor: 5 }, 4)],
      compartilhado,
      rotulo,
      rotuloDim,
    );
    const valores = fato.map(({ registro, posicao }) => validarLinhaValor(registro, posicao, rotulo));
    const inds = montarDadosMercado(valores, [], rotulo, rotulo, compartilhado, rotuloDim);
    expect(inds.map((i) => i.title)).toEqual(["Iron Ores", "Coking Coal"]);
    expect(inds[0].lines.map((l) => l.label)).toEqual(["MB 62%", "Netback"]);
    expect(inds[1].lines.map((l) => l.label)).toEqual(["MB 62%"]);
    expect(inds[0].lines[0].values).toHaveLength(1);
    expect(inds[1].lines[0].values).toHaveLength(1);
  });

  it("montarDadosMercado com dims ordena pela dimensão e exige valor em toda linha", () => {
    const fato = mesclarDimensaoLinhas(
      [fatoRow({ linha: "Netback", valor: 5 }, 2), fatoRow({}, 3)],
      dims,
      rotulo,
      rotuloDim,
    );
    const valores = fato.map(({ registro, posicao }) => validarLinhaValor(registro, posicao, rotulo));
    const [ind] = montarDadosMercado(valores, [], rotulo, rotulo, dims, rotuloDim);
    expect(ind.lines.map((l) => l.label)).toEqual(["MB 62%", "Netback"]);

    expect(() =>
      montarDadosMercado([valores[1]], [], rotulo, rotulo, dims, rotuloDim),
    ).toThrow(/Dim 3.*"Netback".*não tem nenhum\s+valor na fato/);
  });
});
