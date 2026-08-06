import { describe, it, expect } from "vitest";
import {
  scenarioIdDe,
  validarLinhaExplicacao,
  validarLinhaItem,
  montarDadosMercado,
  type Rotulador,
} from "./market-explanations-core";

const rotulo: Rotulador = (l) => `Linha ${l}`;

const base = {
  versao_origem: "BUDGET",
  periodo_origem: "JAN26",
  versao_destino: "MRF7",
  periodo_destino: "JAN26",
  explicacao: "Iron Ores",
  unidade: "Price $/t",
};

function linha(extra: Record<string, unknown>) {
  return { ...base, ...extra };
}

describe("scenarioIdDe — pareamento por cenário", () => {
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

describe("validarLinhaExplicacao", () => {
  it("aceita linha completa e linha só com impacto (ex.: Forex)", () => {
    const cheia = validarLinhaExplicacao(
      linha({ linha: "Pellet premium", valor_origem: 30, valor_destino: 37, variacao: 7, kt: 5.486, impacto_musd: -36 }),
      2,
      rotulo,
    );
    expect(cheia.sourceId).toBe("fy26_m01_budget");
    expect(cheia.targetId).toBe("fy26_m01_mrf7");
    expect(cheia.impactoMusd).toBe(-36);
    const soImpacto = validarLinhaExplicacao(
      linha({ linha: "Forex (contract)", valor_origem: null, valor_destino: null, variacao: null, kt: null, impacto_musd: -6 }),
      3,
      rotulo,
    );
    expect(soImpacto.valorOrigem).toBeNull();
    expect(soImpacto.kt).toBeNull();
  });
  it("rejeita impacto não numérico, coluna vazia e origem = destino", () => {
    expect(() =>
      validarLinhaExplicacao(linha({ linha: "X", impacto_musd: "abc" }), 4, rotulo),
    ).toThrow(/Linha 4.*impacto_musd/);
    expect(() =>
      validarLinhaExplicacao(linha({ linha: "", impacto_musd: 1 }), 5, rotulo),
    ).toThrow(/Linha 5.*coluna "linha" vazia/);
    expect(() =>
      validarLinhaExplicacao(
        linha({ versao_destino: "BUDGET", linha: "X", impacto_musd: 1 }),
        6,
        rotulo,
      ),
    ).toThrow(/Linha 6.*origem e destino iguais/);
  });
  it("rejeita períodos FY/trimestre — armazenamento é mensal", () => {
    expect(() =>
      validarLinhaExplicacao(linha({ periodo_origem: "FY26", periodo_destino: "FY26", linha: "X", impacto_musd: 1 }), 9, rotulo),
    ).toThrow(/Linha 9.*periodo_origem deve ser um mês/);
    expect(() =>
      validarLinhaExplicacao(linha({ periodo_destino: "Q126", linha: "X", impacto_musd: 1 }), 10, rotulo),
    ).toThrow(/Linha 10.*periodo_destino deve ser um mês/);
    expect(() =>
      validarLinhaItem(linha({ periodo_origem: "FY26", item: "Fines" }), 11, rotulo),
    ).toThrow(/Linha 11.*periodo_origem deve ser um mês/);
  });

  it("rejeita valor opcional não numérico", () => {
    expect(() =>
      validarLinhaExplicacao(linha({ linha: "X", kt: "muito", impacto_musd: 1 }), 8, rotulo),
    ).toThrow(/Linha 8.*coluna "kt" não numérica/);
  });
});

describe("montarDadosMercado", () => {
  const exp = (extra: Record<string, unknown>, l: number) =>
    validarLinhaExplicacao(linha(extra), l, rotulo);
  const item = (nome: string, l: number, extra: Record<string, unknown> = {}) =>
    validarLinhaItem(linha({ item: nome, ...extra }), l, rotulo);

  it("agrupa linhas por (par, explicação) e vincula itens", () => {
    const d = montarDadosMercado(
      [
        exp({ linha: "Iron ore MB 62% (1m lag)", valor_origem: 96, valor_destino: 103, variacao: 6, kt: 4.803, impacto_musd: -30 }, 2),
        exp({ linha: "Forex (contract)", impacto_musd: -6 }, 3),
      ],
      [item("Fines", 2), item("Pellets", 3), item("Lumps", 4)],
      rotulo,
      rotulo,
    );
    expect(d.explanations).toHaveLength(1);
    expect(d.explanations[0]).toMatchObject({
      sourceId: "fy26_m01_budget",
      targetId: "fy26_m01_mrf7",
      title: "Iron Ores",
      unitLabel: "Price $/t",
    });
    expect(d.lines.map((l) => l.sortOrder)).toEqual([0, 1]);
    expect(d.items.map((i) => i.item)).toEqual(["Fines", "Pellets", "Lumps"]);
  });

  it("explicações de pares diferentes não se misturam", () => {
    const d = montarDadosMercado(
      [
        exp({ linha: "A", impacto_musd: 1 }, 2),
        exp({ linha: "A", impacto_musd: 2, versao_destino: "MRF6" }, 3),
      ],
      [],
      rotulo,
      rotulo,
    );
    expect(d.explanations).toHaveLength(2);
    expect(d.explanations.map((e) => e.targetId)).toEqual(["fy26_m01_mrf7", "fy26_m01_mrf6"]);
  });

  it("rejeita linha duplicada na mesma explicação", () => {
    expect(() =>
      montarDadosMercado(
        [exp({ linha: "A", impacto_musd: 1 }, 2), exp({ linha: "A", impacto_musd: 2 }, 3)],
        [],
        rotulo,
        rotulo,
      ),
    ).toThrow(/Linha 3.*linha "A" duplicada/);
  });

  it("rejeita item que referencia explicação inexistente (par ou título diferente)", () => {
    expect(() =>
      montarDadosMercado(
        [exp({ linha: "A", impacto_musd: 1 }, 2)],
        [item("Fines", 2, { explicacao: "Coking Coal" })],
        rotulo,
        rotulo,
      ),
    ).toThrow(/Linha 2.*explicação inexistente "Coking Coal"/);
    expect(() =>
      montarDadosMercado(
        [exp({ linha: "A", impacto_musd: 1 }, 2)],
        [item("Fines", 2, { versao_destino: "MRF6" })],
        rotulo,
        rotulo,
      ),
    ).toThrow(/explicação inexistente/);
  });

  it("rejeita item duplicado e unidade inconsistente", () => {
    expect(() =>
      montarDadosMercado(
        [exp({ linha: "A", impacto_musd: 1 }, 2)],
        [item("Fines", 2), item("Fines", 3)],
        rotulo,
        rotulo,
      ),
    ).toThrow(/Linha 3.*item "Fines" duplicado/);
    expect(() =>
      montarDadosMercado(
        [exp({ linha: "A", impacto_musd: 1 }, 2), exp({ linha: "B", impacto_musd: 1, unidade: "US$/t" }, 3)],
        [],
        rotulo,
        rotulo,
      ),
    ).toThrow(/Linha 3.*unidade inconsistente/);
  });
});
