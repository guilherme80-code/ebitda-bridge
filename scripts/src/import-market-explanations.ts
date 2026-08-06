/**
 * Importa as EXPLICAÇÕES DE MERCADO do painel Bridge de EBITDA a partir de um
 * Excel com duas abas:
 *   - "Explicacoes": versao_origem | periodo_origem | versao_destino |
 *     periodo_destino | explicacao | linha | valor_origem | valor_destino |
 *     variacao | kt | impacto_musd | unidade (opcional)
 *   - "Itens": versao_origem | periodo_origem | versao_destino |
 *     periodo_destino | explicacao | item
 *
 * As validações vivem em market-explanations-core.ts. Erros de formato apontam
 * a linha da planilha; nada é gravado fora da transação. A importação substitui
 * todas as explicações de mercado existentes.
 *
 * Uso: pnpm --filter @workspace/scripts run import-market-explanations [caminho.xlsx]
 */
import path from "node:path";
import * as fs from "node:fs";
import * as XLSX from "xlsx";
import {
  COLUNAS_EXPLICACOES,
  COLUNAS_ITENS,
  validarLinhaExplicacao,
  validarLinhaItem,
  montarDadosMercado,
  gravarDadosMercado,
  fecharConexao,
  resumoMercado,
  type Rotulador,
} from "./market-explanations-core.js";

const DEFAULT_PATH = path.resolve(
  import.meta.dirname,
  "../../exports/Explicacoes_Mercado_Bridge_EBITDA.xlsx",
);
const SHEET_EXPLICACOES = "Explicacoes";
const SHEET_ITENS = "Itens";

function lerAba(
  wb: XLSX.WorkBook,
  nome: string,
  colunas: readonly string[],
  arquivo: string,
): Record<string, unknown>[] {
  const ws = wb.Sheets[nome];
  if (!ws) {
    throw new Error(
      `Aba "${nome}" não encontrada em ${arquivo} (abas presentes: ${wb.SheetNames.join(", ")})`,
    );
  }
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
  if (raw.length === 0) throw new Error(`Aba "${nome}" está vazia`);
  const headers = Object.keys(raw[0]);
  const faltando = colunas.filter((c) => !headers.includes(c));
  if (faltando.length > 0) {
    throw new Error(
      `Colunas obrigatórias ausentes na aba "${nome}": ${faltando.join(", ")} ` +
        `(colunas presentes: ${headers.join(", ")})`,
    );
  }
  return raw;
}

async function main() {
  const filePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_PATH;
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo não encontrado: ${filePath}`);
  }
  const wb = XLSX.read(fs.readFileSync(filePath));
  const nome = path.basename(filePath);

  const rawExp = lerAba(wb, SHEET_EXPLICACOES, COLUNAS_EXPLICACOES, nome);
  const rawItens = lerAba(wb, SHEET_ITENS, COLUNAS_ITENS, nome);

  const rotuloExp: Rotulador = (l) => `Aba "${SHEET_EXPLICACOES}", linha ${l}`;
  const rotuloItem: Rotulador = (l) => `Aba "${SHEET_ITENS}", linha ${l}`;

  // linha na planilha: +1 do cabeçalho, +1 para 1-based
  const explicacoes = rawExp.map((r, i) => validarLinhaExplicacao(r, i + 2, rotuloExp));
  const itens = rawItens.map((r, i) => validarLinhaItem(r, i + 2, rotuloItem));

  const dados = montarDadosMercado(explicacoes, itens, rotuloExp, rotuloItem);
  console.log(resumoMercado(dados));

  await gravarDadosMercado(dados);
  console.log(`Importado de ${nome} (abas "${SHEET_EXPLICACOES}" e "${SHEET_ITENS}")`);
  await fecharConexao();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
