/**
 * Importa a fonte de indicadores DIRETO das tabelas do Databricks, sem passar
 * pelo Excel. Contrato dimensional (docs/modelo-indicadores.md, modelo SAC):
 *
 *   - tabela FATO:      versao | periodo | item | indicador | valor
 *   - tabela DIMENSÃO:  item | secao | moeda | atributo | grupo
 *
 * A dimensão é opcional para compatibilidade: sem ela, a fato deve trazer as
 * propriedades (secao/moeda/atributo/grupo) em cada registro (formato antigo).
 * Se as duas trouxerem propriedades, elas são conferidas e conflitos
 * interrompem tudo.
 *
 * Reutiliza as validações do importador de Excel (indicadores-core.ts);
 * erros de formato apontam o registro problemático ("Registro N") e nada é
 * gravado fora da transação.
 *
 * Pré-requisitos:
 *   - Conector "Databricks (Service Principal)" (databricks-m2m) configurado
 *     no workspace Replit (Settings → Connectors) — as credenciais vêm de lá,
 *     nada de token em código.
 *   - Um SQL Warehouse ativo no Databricks (o id pode vir do conector ou da
 *     variável DATABRICKS_WAREHOUSE_ID).
 *
 * Uso:
 *   pnpm --filter @workspace/scripts run import-databricks <catalogo.schema.fato> [catalogo.schema.itens]
 *   (ou defina DATABRICKS_INDICADORES_TABLE e DATABRICKS_ITENS_TABLE)
 */
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

const rotulo: Rotulador = (n) => `Registro ${n}`;
const rotuloItens: Rotulador = (n) => `Tabela de itens, registro ${n}`;

// ---------------------------------------------------------------------------
// Credenciais via conector Replit (databricks-m2m) — nunca em código/segredo solto
// ---------------------------------------------------------------------------

type Credenciais = { host: string; token: string; warehouseId: string | null };

async function obterCredenciais(): Promise<Credenciais> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;
  if (!hostname || !xReplitToken) {
    throw new Error(
      "Ambiente Replit sem acesso ao proxy de conectores " +
        "(REPLIT_CONNECTORS_HOSTNAME/REPL_IDENTITY ausentes). " +
        "Rode dentro do workspace Replit.",
    );
  }
  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=databricks-m2m`,
    { headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken } },
  );
  if (!res.ok) {
    throw new Error(`Falha ao consultar conectores Replit: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { items?: Array<Record<string, any>> };
  const conn = data.items?.[0];
  const settings = conn?.settings ?? {};
  const token: string | undefined =
    settings.access_token ??
    settings.oauth?.credentials?.access_token ??
    conn?.settings?.token;
  const hostRaw: string | undefined =
    settings.host ?? settings.server_hostname ?? settings.hostname ?? settings.workspace_url;
  if (!conn || !token || !hostRaw) {
    throw new Error(
      'Conector Databricks não configurado. Configure "Databricks (Service Principal)" ' +
        "em Settings → Connectors no workspace Replit e tente de novo.",
    );
  }
  const host = hostRaw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  // warehouse: direto no conector, via http_path (/sql/1.0/warehouses/<id>) ou env
  let warehouseId: string | null =
    settings.warehouse_id ?? process.env.DATABRICKS_WAREHOUSE_ID ?? null;
  if (!warehouseId && typeof settings.http_path === "string") {
    const m = settings.http_path.match(/warehouses\/([a-z0-9]+)/i);
    if (m) warehouseId = m[1];
  }
  return { host, token, warehouseId };
}

// ---------------------------------------------------------------------------
// Consulta via SQL Statement Execution API
// ---------------------------------------------------------------------------

async function api(cred: Credenciais, caminho: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://${cred.host}${caminho}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cred.token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Databricks HTTP ${res.status} em ${caminho}: ${body.slice(0, 500)}`);
  }
  return body ? JSON.parse(body) : {};
}

function validarNomeTabela(tabela: string): string {
  if (!/^[A-Za-z0-9_`.]+$/.test(tabela)) {
    throw new Error(`Nome de tabela inválido: "${tabela}" (esperado catalogo.schema.tabela)`);
  }
  return tabela;
}

async function consultarTabela(
  cred: Credenciais,
  tabela: string,
): Promise<Record<string, unknown>[]> {
  if (!cred.warehouseId) {
    throw new Error(
      "SQL Warehouse não identificado. Defina DATABRICKS_WAREHOUSE_ID com o id " +
        "do warehouse (Databricks → SQL Warehouses → Connection details).",
    );
  }
  // A ordem das linhas define a ordem de exibição no painel — o contrato é
  // 1 linha da tabela = 1 linha da aba; preservamos a ordem natural retornada.
  // SELECT *: as colunas obrigatórias são validadas depois, contra o contrato.
  const executar = async () => {
    const sql = `SELECT * FROM ${validarNomeTabela(tabela)}`;
    let stmt = await api(cred, "/api/2.0/sql/statements", {
      method: "POST",
      body: JSON.stringify({
        statement: sql,
        warehouse_id: cred.warehouseId,
        wait_timeout: "30s",
        disposition: "INLINE",
        format: "JSON_ARRAY",
        row_limit: 1000000,
      }),
    });
    // aguarda conclusão (warehouse pode estar acordando)
    const inicio = Date.now();
    while (["PENDING", "RUNNING"].includes(stmt.status?.state)) {
      if (Date.now() - inicio > 5 * 60_000) {
        throw new Error("Tempo esgotado aguardando o Databricks executar a consulta (5 min).");
      }
      await new Promise((r) => setTimeout(r, 3000));
      stmt = await api(cred, `/api/2.0/sql/statements/${stmt.statement_id}`);
    }
    if (stmt.status?.state !== "SUCCEEDED") {
      const err = stmt.status?.error;
      throw new Error(
        `Consulta falhou no Databricks (${stmt.status?.state}): ` +
          `${err?.message ?? "sem detalhe"}\nSQL: ${sql}`,
      );
    }
    return stmt;
  };

  const stmt = await executar();

  const cols: string[] = (stmt.manifest?.schema?.columns ?? []).map((c: any) => c.name);
  const tipos: string[] = (stmt.manifest?.schema?.columns ?? []).map((c: any) =>
    String(c.type_name ?? "").toUpperCase(),
  );
  const linhas: unknown[][] = [...(stmt.result?.data_array ?? [])];

  // resultados em múltiplos chunks
  let next: string | undefined = stmt.result?.next_chunk_internal_link;
  while (next) {
    const chunk = await api(cred, next);
    linhas.push(...(chunk.data_array ?? []));
    next = chunk.next_chunk_internal_link;
  }

  // JSON_ARRAY devolve tudo como string — converte valor para número e
  // vazios para null, espelhando o que o leitor de Excel entrega ao core.
  const numerico = new Set(["INT", "BIGINT", "SMALLINT", "TINYINT", "FLOAT", "DOUBLE", "DECIMAL"]);
  return linhas.map((arr) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, j) => {
      const v = arr[j];
      if (v === null || v === undefined || v === "") {
        obj[c] = null;
      } else if (c === "valor" || numerico.has(tipos[j])) {
        const n = Number(v);
        obj[c] = Number.isFinite(n) ? n : v; // não numérico fica como veio → erro claro na validação
      } else {
        obj[c] = String(v);
      }
    });
    return obj;
  });
}

// ---------------------------------------------------------------------------

async function main() {
  const tabelaFato = process.argv[2] ?? process.env.DATABRICKS_INDICADORES_TABLE;
  const tabelaItens = process.argv[3] ?? process.env.DATABRICKS_ITENS_TABLE;
  if (!tabelaFato) {
    throw new Error(
      "Informe a tabela fato: pnpm --filter @workspace/scripts run import-databricks " +
        "<catalogo.schema.fato> [catalogo.schema.itens] " +
        "(ou defina DATABRICKS_INDICADORES_TABLE e DATABRICKS_ITENS_TABLE)",
    );
  }

  const cred = await obterCredenciais();
  console.log(`Consultando ${tabelaFato} em ${cred.host}...`);
  const raw = await consultarTabela(cred, tabelaFato);
  if (raw.length === 0) throw new Error(`Tabela ${tabelaFato} está vazia`);

  const presentes = Object.keys(raw[0]);
  // Com a tabela de itens, a fato só precisa das colunas enxutas; sem ela,
  // as propriedades (secao etc.) devem vir na própria fato (formato antigo).
  const obrigatorias = tabelaItens ? COLUNAS_FATO : COLUNAS;
  const faltando = obrigatorias.filter((c) => !presentes.includes(c));
  if (faltando.length > 0) {
    throw new Error(
      `Colunas obrigatórias ausentes em ${tabelaFato}: ${faltando.join(", ")} ` +
        `(colunas presentes: ${presentes.join(", ")})`,
    );
  }

  // Registro N = N-ésima linha retornada pela tabela (1-based)
  let fato = raw.map((registro, i) => ({ registro, posicao: i + 1 }));
  let dims;
  if (tabelaItens) {
    console.log(`Consultando ${tabelaItens} em ${cred.host}...`);
    const rawItens = await consultarTabela(cred, tabelaItens);
    if (rawItens.length === 0) throw new Error(`Tabela ${tabelaItens} está vazia`);
    const presentesItens = Object.keys(rawItens[0]);
    const faltandoItens = COLUNAS_ITENS.filter((c) => !presentesItens.includes(c));
    if (faltandoItens.length > 0) {
      throw new Error(
        `Colunas obrigatórias ausentes em ${tabelaItens}: ${faltandoItens.join(", ")} ` +
          `(colunas presentes: ${presentesItens.join(", ")})`,
      );
    }
    // Tabelas SQL não têm ordem inerente: a coluna ordinal "sort_order" é
    // OBRIGATÓRIA na dimensão do Databricks e fixa a ordem de exibição.
    const ordenadas = ordenarDimensao(
      rawItens.map((registro, i) => ({ registro, posicao: i + 1 })),
      rotuloItens,
      true,
    );
    dims = ordenadas.map(({ registro, posicao }) => validarItemDim(registro, posicao, rotuloItens));
    fato = mesclarDimensao(fato, dims, rotulo, rotuloItens);
  }

  const registros = fato.map(({ registro, posicao }) => validarLinha(registro, posicao, rotulo));
  const dados = montarDados(registros, rotulo, dims);
  console.log(resumo(registros.length, dados));

  await gravarDados(dados);
  console.log(`Importado do Databricks: ${tabelaFato} (${registros.length} registros)`);
  await fecharConexao();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
