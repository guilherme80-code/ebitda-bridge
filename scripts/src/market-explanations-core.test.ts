import { describe, it, expect } from "vitest";
import {
  scenarioIdDe,
  validarLinhaValor,
  validarLinhaItem,
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
