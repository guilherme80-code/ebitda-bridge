# Modelo de indicadores — dimensão + fato (modelo SAC)

Fonte de dados do painel Bridge de EBITDA no formato **dimensional**, espelhando
o modelo do SAP SAC e o contrato para as tabelas no Databricks:

- **Dimensão "Itens"** — um registro por item, com as propriedades;
- **Fato "Indicadores"** — registros enxutos: versão × período × item ×
  indicador → valor.

No Excel são duas abas ("Itens" e "Indicadores"); no Databricks, duas tabelas
(uma linha da tabela = uma linha da aba).

## Aba/tabela "Itens" (dimensão)

| Coluna     | Obrigatória | Descrição |
|------------|-------------|-----------|
| `item`     | sim | Chave da dimensão: produto, categoria de custo, insumo ou rótulo do ajuste (`Global` em Parametros). Único em toda a dimensão |
| `secao`    | sim | `Parametros` \| `Vendas` \| `CustoFixo` \| `Insumos` \| `Ajustes` |
| `moeda`    | não | `BRL` ou `USD` (Vendas e CustoFixo) |
| `atributo` | não | Flag do item (ver por seção) |
| `grupo`    | não | Grupo de exibição do item nas tabelas detalhadas (ex.: `Blacks`, `Reds`, `Controllable`, `Operational performance`). Não se aplica a Parametros |
| `sort_order` | Databricks: sim; Excel: não | Ordinal que fixa a ordem de exibição dos itens (numérico, único). Obrigatório na tabela do Databricks (tabelas SQL não têm ordem inerente); no Excel a ordem das linhas da planilha vale como padrão e `sort_order`, quando presente, prevalece |

A **ordem de exibição** dos itens no painel vem da dimensão: pela coluna
`sort_order` quando presente (obrigatória no Databricks), senão pela ordem
das linhas da planilha. Membros da dimensão ainda sem nenhum valor na fato são
válidos e preservados na importação (a dimensão é a fonte da verdade do
conjunto de itens); item da fato fora da dimensão interrompe a importação.

## Aba/tabela "Indicadores" (fato)

| Coluna      | Obrigatória | Descrição |
|-------------|-------------|-----------|
| `versao`    | sim | Versão do cenário: `ACTUAL`, `BUDGET`, `MRF1` … `MRF7` (`MRF01`…`MRF09` também são aceitos e normalizados) |
| `periodo`   | sim | Período: sempre mensal, `JAN26`…`DEC26`. A fonte NÃO traz FY nem trimestres — o painel consolida FY e trimestres somando os meses da versão (câmbio, preços de insumos e participação de custo doméstico entram como médias ponderadas). FY/trimestre só aparecem no painel quando todos os meses do período têm dados |
| `item`      | sim | Chave do item — deve constar na dimensão "Itens" |
| `indicador` | sim | Nome do indicador (lista abaixo, por seção) |
| `valor`     | sim | Valor numérico |

Compatibilidade: sem a aba/tabela "Itens", a fato pode trazer as propriedades
(`secao`, `moeda`, `atributo`, `grupo`) em cada linha (formato antigo). Se as
duas trouxerem propriedades, elas são conferidas e **qualquer conflito
interrompe a importação**. Item da fato fora da dimensão também interrompe.

## Indicadores por seção

### Parametros (item = `Global`) — obrigatórios em todo cenário
- `cambio_brl_usd` — taxa de câmbio geral
- `cambio_custo_fixo_brl_usd` — câmbio específico do bloco de custo fixo
- `aco_bruto_kt` — produção de aço bruto (kt)
- `ebitda_kusd` — EBITDA do cenário (kUSD)
- `participacao_custo_interno` — parcela do custo em moeda local usada no efeito câmbio

### Vendas (item = produto)
- `quantidade_kt`, `montante_kusd`, `custo_variavel_kusd`
- `moeda`: `BRL` (mercado interno) ou `USD` (exportação/intragrupo)
- `atributo`: `interno` (receita exposta ao câmbio) ou `externo`

### CustoFixo (item = categoria)
- `montante_kusd`
- `moeda`: `USD` para categorias denominadas em dólar (sem efeito câmbio), senão `BRL`

### Insumos (item = insumo) — dois formatos
- Precificados: `preco_usd_t` **e** `fator_rendimento` (efeito = Δpreço × rendimento × aço bruto)
- Diretos: `montante_kusd` (efeito = destino − origem)

### Ajustes (item = rótulo)
- `montante_kusd`
- `atributo`: `consumo` \| `outros` \| `variacao_estoque`

## Regras
- Unidades: montantes em kUSD, quantidades em kt, preços em USD/t.
- As propriedades de um item valem para TODAS as versões e períodos — o modelo
  dimensional não admite o mesmo item com propriedades diferentes por cenário.
- Linhas com seção/indicador desconhecido, valor não numérico, item fora da
  dimensão ou propriedade em conflito interrompem a importação com mensagem
  apontando a linha do problema (nada é gravado).

## Banco do painel
- `dim_items` (item, secao, moeda, atributo, grupo, sort_order) e
  `indicator_facts` (scenario_id, item, indicador, valor) são a fonte canônica;
  o painel reconstrói as visões largas na leitura.

## Arquivos e comandos
- Especificação: este documento. As explicações de mercado seguem contrato
  análogo (dimensão "Linhas" + fato "Explicacoes" + "Itens") em
  `export-market-explanations` / `import-market-explanations`.
- Exportar dados atuais para o formato: `pnpm --filter @workspace/scripts run export-indicadores`
  → gera `exports/Fonte_Indicadores_Bridge_EBITDA.xlsx` (abas "Itens" e "Indicadores").
- Importar para o banco: `pnpm --filter @workspace/scripts run import-indicadores [caminho.xlsx]`
- Importar direto das tabelas do Databricks (mesmas colunas, mesmas validações):
  `pnpm --filter @workspace/scripts run import-databricks <catalogo.schema.fato> [catalogo.schema.itens]`
  (ou defina `DATABRICKS_INDICADORES_TABLE` e `DATABRICKS_ITENS_TABLE`).
  Requer o conector "Databricks (Service Principal)" configurado no workspace
  Replit (Settings → Connectors) e, se o conector não trouxer o warehouse, a
  variável `DATABRICKS_WAREHOUSE_ID`. Erros de formato apontam o registro
  problemático ("Registro N"), como na importação do Excel.
