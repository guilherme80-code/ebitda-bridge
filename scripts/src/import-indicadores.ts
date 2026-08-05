/**
 * Importa a fonte de dados do painel Bridge de EBITDA a partir de UMA ÚNICA
 * ABA ("Indicadores"), conforme docs/modelo-indicadores.md.
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
  validarLinha,
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

const rotulo: Rotulador = (linha) => `Linha ${linha}`;

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
  const headers = Object.keys(raw[0]);
  const faltando = COLUNAS.filter((c) => !headers.includes(c));
  if (faltando.length > 0) {
    throw new Error(
      `Colunas obrigatórias ausentes na aba "${SHEET}": ${faltando.join(", ")} ` +
        `(colunas presentes: ${headers.join(", ")})`,
    );
  }

  // linha na planilha: +1 do cabeçalho, +1 para 1-based
  const registros = raw.map((r, i) => validarLinha(r, i + 2, rotulo));
  const dados = montarDados(registros, rotulo);
  console.log(resumo(registros.length, dados));

  await gravarDados(dados);
  console.log(`Importado de ${path.basename(filePath)} (aba "${SHEET}")`);
  await fecharConexao();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
