/**
 * Importa a fonte de dados do painel Bridge de EBITDA no formato dimensional
 * (modelo SAC), conforme docs/modelo-indicadores.md:
 *   - aba "Itens" (dimensão): item | secao | moeda | atributo | grupo
 *   - aba "Indicadores" (fato): versao | periodo | item | indicador | valor
 *
 * A aba "Itens" é opcional para compatibilidade: sem ela, a aba "Indicadores"
 * deve trazer as propriedades em cada linha (formato antigo). Se as duas
 * trouxerem propriedades, elas são conferidas e conflitos interrompem tudo.
 *
 * As validações vivem em indicadores-core.ts (compartilhadas com a importação
 * direta do Databricks — import-databricks.ts). Erros de formato apontam a
 * linha da planilha; nada é gravado fora da transação.
 *
 * Uso: pnpm --filter @workspace/scripts run import-indicadores [caminho.xlsx]
 */
import path from "node:path";
import * as fs from "node:fs";
import * as XLSX from "xlsx";
import {
  COLUNAS,
  COLUNAS_FATO,
  COLUNAS_ITENS,
  validarLinha,
  validarItemDim,
  ordenarDimensao,
  mesclarDimensao,
  montarDados,
  gravarDados,
  fecharConexao,
  resumo,
  type Rotulador,
} from "./indicadores-core.js";

const DEFAULT_PATH = path.resolve(
  import.meta.dirname,
  "../../exports/Fonte_Indicadores_Bridge_EBITDA.xlsx",
);
const SHEET = "Indicadores";
const SHEET_ITENS = "Itens";

const rotulo: Rotulador = (linha) => `Linha ${linha}`;
const rotuloItens: Rotulador = (linha) => `Aba "Itens", linha ${linha}`;

async function main() {
  const filePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_PATH;
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Arquivo não encontrado: ${filePath}\n` +
        `Gere-o com: pnpm --filter @workspace/scripts run export-indicadores`,
    );
  }
  const wb = XLSX.read(fs.readFileSync(filePath));
  const ws = wb.Sheets[SHEET];
  if (!ws) {
    throw new Error(
      `Aba "${SHEET}" não encontrada em ${path.basename(filePath)} ` +
        `(abas presentes: ${wb.SheetNames.join(", ")})`,
    );
  }

  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
  if (raw.length === 0) throw new Error(`Aba "${SHEET}" está vazia`);
  // Aba "Itens" (dimensão) — opcional para compatibilidade com o formato
  // antigo. Com ela, a aba "Indicadores" só precisa das colunas enxutas.
  const wsItens = wb.Sheets[SHEET_ITENS];
  const headers = Object.keys(raw[0]);
  const obrigatorias = wsItens ? COLUNAS_FATO : COLUNAS;
  const faltando = obrigatorias.filter((c) => !headers.includes(c));
  if (faltando.length > 0) {
    throw new Error(
      `Colunas obrigatórias ausentes na aba "${SHEET}": ${faltando.join(", ")} ` +
        `(colunas presentes: ${headers.join(", ")})`,
    );
  }

  // linha na planilha: +1 do cabeçalho, +1 para 1-based
  let fato = raw.map((registro, i) => ({ registro, posicao: i + 2 }));
  let dims;
  if (wsItens) {
    const rawItens = XLSX.utils.sheet_to_json<Record<string, unknown>>(wsItens, {
      defval: null,
    });
    if (rawItens.length === 0) throw new Error(`Aba "${SHEET_ITENS}" está vazia`);
    const headersItens = Object.keys(rawItens[0]);
    const faltandoItens = COLUNAS_ITENS.filter((c) => !headersItens.includes(c));
    if (faltandoItens.length > 0) {
      throw new Error(
        `Colunas obrigatórias ausentes na aba "${SHEET_ITENS}": ${faltandoItens.join(", ")} ` +
          `(colunas presentes: ${headersItens.join(", ")})`,
      );
    }
    // sort_order opcional no Excel (a ordem das linhas já é determinística);
    // quando presente, prevalece.
    const ordenadas = ordenarDimensao(
      rawItens.map((registro, i) => ({ registro, posicao: i + 2 })),
      rotuloItens,
      false,
    );
    dims = ordenadas.map(({ registro, posicao }) => validarItemDim(registro, posicao, rotuloItens));
    fato = mesclarDimensao(fato, dims, rotulo, rotuloItens);
  }

  const registros = fato.map(({ registro, posicao }) => validarLinha(registro, posicao, rotulo));
  const dados = montarDados(registros, rotulo, dims);
  console.log(resumo(registros.length, dados));

  await gravarDados(dados);
  console.log(`Importado de ${path.basename(filePath)} (aba "${SHEET}")`);
  await fecharConexao();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
