# Modelo de indicadores — fonte em uma única aba

Fonte de dados do painel Bridge de EBITDA em **uma única aba** ("Indicadores"),
no formato "longo": cada linha é um registro padronizado. O mesmo layout serve
como contrato para a futura tabela no Databricks (uma linha da tabela = uma
linha da aba).

## Colunas

| Coluna      | Obrigatória | Descrição |
|-------------|-------------|-----------|
| `versao`    | sim | Versão do cenário: `BUDGET`, `MRF1` … `MRF7` |
| `periodo`   | sim | Período: `FY26` (ano), `Q126`…`Q426` (trimestre), `JAN26`…`DEC26` (mês) |
| `secao`     | sim | `Parametros` \| `Vendas` \| `CustoFixo` \| `Insumos` \| `Ajustes` |
| `item`      | sim | Produto, categoria de custo, insumo ou rótulo do ajuste (`Global` em Parametros) |
| `indicador` | sim | Nome do indicador (lista abaixo, por seção) |
| `valor`     | sim | Valor numérico |
| `moeda`     | não | `BRL` ou `USD` (Vendas e CustoFixo) |
| `atributo`  | não | Flag da linha (ver por seção) |

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
- A ordem das linhas define a ordem de exibição dos itens nas tabelas do painel.
- Linhas com seção/indicador desconhecido ou valor não numérico interrompem a
  importação com mensagem apontando a linha do problema (nada é gravado).

## Arquivos e comandos
- Especificação: este documento.
- Exportar dados atuais para o formato: `pnpm --filter @workspace/scripts run export-indicadores`
  → gera `exports/Fonte_Indicadores_Bridge_EBITDA.xlsx` (aba única "Indicadores").
- Importar a aba única para o banco: `pnpm --filter @workspace/scripts run import-indicadores [caminho.xlsx]`
