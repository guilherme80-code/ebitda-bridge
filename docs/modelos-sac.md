# Roteiro — criação dos dois modelos no SAP SAC

Guia para criar no SAC os dois modelos que alimentam o painel Bridge de
EBITDA e replicá-los no Databricks. Contém, para cada modelo: dimensões com
chave e propriedades, medidas/contas, granularidade e o **de-para coluna a
coluna** entre SAC ↔ Databricks ↔ PostgreSQL ↔ arquivos de export (Excel).

Referências: `docs/modelo-indicadores.md` (contrato de importação) e
`docs/esquema-banco.md` (esquema físico do banco).

## Convenções comuns aos dois modelos

- **Granularidade: versão × mês.** Versões: `ACTUAL`, `BUDGET`, `MRF1`…`MRF7`.
  Períodos: somente meses `JAN26`…`DEC26`. NÃO carregue FY nem trimestres — o
  painel deriva FY/Q somando meses (taxas entram como médias ponderadas).
- **Unidades**: montantes em kUSD, quantidades em kt, preços em USD/t
  (explicações também usam MUSD nas linhas de montante).
- **Chave dos membros de dimensão é global**: as propriedades de um membro
  valem para todas as versões e meses. Não modele propriedade que varia por
  cenário.
- **Ordem de exibição** vem da dimensão (propriedade `sort_order`). Nas
  tabelas do Databricks a coluna é obrigatória (tabelas SQL não têm ordem
  inerente); no Excel a ordem das linhas vale como padrão.
- Membros de dimensão ainda sem dados são válidos e devem ser preservados.

---

## Modelo 1 — Indicadores (fonte do bridge)

### Estrutura no SAC

| Elemento SAC | Conteúdo |
|---|---|
| Dimensão **Versão** (category/version) | `ACTUAL`, `BUDGET`, `MRF1`…`MRF7` |
| Dimensão **Tempo** | Mensal, `JAN26`…`DEC26` |
| Dimensão **Item** (genérica, com propriedades) | Um membro por item; ver propriedades abaixo |
| Dimensão de **conta** (medida) **Indicador** | Contas listadas abaixo, por seção |
| Medida | `valor` (numérica) |

Célula do modelo = Versão × Mês × Item × Indicador → 1 valor.

### Dimensão "Item" — propriedades

| Propriedade SAC | Valores | Obrigatória |
|---|---|---|
| `secao` | `Parametros` \| `Vendas` \| `CustoFixo` \| `Insumos` \| `Ajustes` | sim |
| `moeda` | `BRL` \| `USD` (só Vendas e CustoFixo) | não |
| `atributo` | Vendas: `interno`/`externo`; Ajustes: `consumo`/`outros`/`variacao_estoque` | não |
| `grupo` | grupo de exibição (ex.: `Blacks`, `Reds`, `Controllable`, `Operational performance`) | não |
| `sort_order` | ordinal numérico único (ordem de exibição) | sim |

Membro especial: `Global` (secao `Parametros`) carrega os parâmetros do
cenário.

### Contas (dimensão "Indicador"), por seção do item

| Seção | Contas | Observações |
|---|---|---|
| Parametros (`Global`) | `cambio_brl_usd`, `cambio_custo_fixo_brl_usd`, `aco_bruto_kt`, `ebitda_kusd`, `participacao_custo_interno` | Todas obrigatórias em todo cenário |
| Vendas | `quantidade_kt`, `montante_kusd`, `custo_variavel_kusd` | As três por produto |
| CustoFixo | `montante_kusd` | |
| Insumos | `preco_usd_t` + `fator_rendimento` (precificados) **ou** `montante_kusd` (diretos) | Um item usa um formato, nunca os dois |
| Ajustes | `montante_kusd` | |

### De-para — dimensão de itens

| SAC (dimensão Item) | Databricks (tabela itens) | PostgreSQL `dim_items` | Excel aba "Itens" |
|---|---|---|---|
| ID do membro | `item` | `item` (PK) | `item` |
| propriedade `secao` | `secao` | `secao` | `secao` |
| propriedade `moeda` | `moeda` | `moeda` | `moeda` |
| propriedade `atributo` | `atributo` | `atributo` | `atributo` |
| propriedade `grupo` | `grupo` | `grupo` | `grupo` |
| propriedade `sort_order` | `sort_order` (obrigatória) | `sort_order` | `sort_order` (opcional; senão, ordem das linhas) |

### De-para — fato de indicadores

| SAC | Databricks (tabela fato) | PostgreSQL `indicator_facts` | Excel aba "Indicadores" |
|---|---|---|---|
| Versão | `versao` | via `scenario_id` (`fy26_m01_budget` → versão) | `versao` |
| Mês | `periodo` | via `scenario_id` | `periodo` |
| Membro Item | `item` | `item` (FK → `dim_items`) | `item` |
| Conta | `indicador` | `indicador` | `indicador` |
| Valor | `valor` | `valor` | `valor` |

Unicidade: versão × mês × item × indicador (no banco:
`UNIQUE(scenario_id, item, indicador)`).

### Carga a partir do Databricks

```
pnpm --filter @workspace/scripts run import-databricks <catalogo.schema.fato> [catalogo.schema.itens]
```

(ou variáveis `DATABRICKS_INDICADORES_TABLE` / `DATABRICKS_ITENS_TABLE`).
Sem a tabela de itens, a fato deve trazer as propriedades em cada linha
(formato antigo); com as duas, propriedades repetidas são conferidas e
conflitos interrompem a carga. Arquivo de referência com os dados atuais:
`exports/Fonte_Indicadores_Bridge_EBITDA.xlsx`.

---

## Modelo 2 — Explicações de mercado

Tabelas de referência (ex.: Iron Ores) exibidas em pop-up ao clicar em itens
do bridge. Cada **explicação** tem **linhas** (ex.: `Iron ore MB 62% (1m lag)`)
com valores por versão × mês, e uma lista de **itens do bridge** vinculados.

### Estrutura no SAC

| Elemento SAC | Conteúdo |
|---|---|
| Dimensão **Versão** | `ACTUAL`, `BUDGET`, `MRF1`…`MRF7` |
| Dimensão **Tempo** | Mensal, `JAN26`…`DEC26` |
| Dimensão **Linha** (genérica, com propriedades) | Um membro por par explicação + linha. Como IDs de membro no SAC são globais na dimensão, o **ID técnico do membro é a chave composta serializada** `<explicacao>|<linha>` (ex.: `Iron Ores|Freight`); o rótulo exibido (description) é `linha`, e `explicacao` é propriedade |
| Medidas | `valor` e `kt` (volume, opcional — só linhas de preço) |

Célula = Versão × Mês × Linha → valor (e kt quando aplicável). O impacto em
$m NÃO é armazenado: o painel calcula na leitura
(`preço`: sentido × Δvalor × kt ÷ 1000; `valor`: sentido × Δvalor).

### Dimensão "Linha" — propriedades

| Elemento SAC | Valores | Obrigatório |
|---|---|---|
| **ID do membro** | `<explicacao>|<linha>` serializado com `|` (ex.: `Iron Ores|Freight`). Garante unicidade global mesmo com rótulos repetidos entre explicações: `Iron Ores|Freight` e `Coal|Freight` são membros distintos. Para a serialização ser injetiva, **o caractere `|` é PROIBIDO em `explicacao` e em `linha`** (senão `A|B`+`C` colidiria com `A`+`B|C`); o importador rejeita valores com `|` nessas colunas | sim |
| **Description (rótulo exibido)** | o rótulo `linha` (ex.: `Freight`) | sim |
| propriedade `explicacao` | nome da explicação (ex.: `Iron Ores`) — parte da chave composta | sim |
| `tipo` | `preco` (valor é preço USD/t) \| `valor` (montante MUSD) | sim (padrão `preco`) |
| `sentido` | `1` (aumento melhora o EBITDA) \| `-1` (piora — custo) | sim (padrão `-1`) |
| `unidade` | unidade exibida (ex.: `Price $/t`) — igual para todas as linhas da mesma explicação | não |

**A identidade da linha é o par `explicacao` + `linha`** — o mesmo rótulo
pode existir em explicações diferentes; duplicar o par dentro da mesma
explicação interrompe a carga. Nas outras pontas (Databricks/Postgres/Excel)
a chave fica em duas colunas separadas; só o SAC serializa as duas no ID do
membro. A ordem das linhas na dimensão define a ordem de exibição, e
explicações aparecem na ordem da primeira linha.

### Tabelas no Databricks (contrato)

Três tabelas, uma linha da tabela = uma linha da aba correspondente do
export. Como no Modelo 1, tabelas SQL não têm ordem inerente — a tabela de
linhas leva a coluna ordinal `sort_order` (numérica, única), que fixa a ordem
de exibição das linhas (e, pela primeira linha de cada explicação, a ordem
das explicações). **`sort_order` é exclusiva do Databricks neste modelo**: o
Excel de explicações não traz nem valida essa coluna — nele a ordem das
linhas da planilha é a ordem de exibição. Ao exportar do Databricks para
Excel, ordene as linhas por `sort_order` antes de gravar a aba "Linhas".

| Tabela | Colunas |
|---|---|
| linhas (dimensão) | `explicacao`, `linha`, `tipo`, `sentido`, `unidade`, `sort_order` |
| explicacoes (fato) | `versao`, `periodo`, `explicacao`, `linha`, `valor`, `kt` |
| itens (vínculos) | `explicacao`, `item` (ordem irrelevante) |

### De-para — dimensão de linhas

| SAC (dimensão Linha) | Databricks (tabela linhas) | PostgreSQL | Excel aba "Linhas" |
|---|---|---|---|
| ID do membro = `<explicacao>|<linha>` | `explicacao` + `linha` (duas colunas) | `market_indicators.title` + `market_indicator_lines.label` | `explicacao` + `linha` |
| propriedade `explicacao` | `explicacao` | `market_indicators.title` | `explicacao` |
| description (rótulo exibido) | `linha` | `market_indicator_lines.label` | `linha` |
| propriedade `tipo` | `tipo` (`preco`/`valor`) | `kind` (`price`/`amount`) | `tipo` (`preco`/`valor`) |
| propriedade `sentido` | `sentido` (1/−1) | `direction` (1/−1) | `sentido` (1/−1) |
| propriedade `unidade` | `unidade` | `market_indicators.unit_label` | `unidade` |
| ordem de exibição | `sort_order` (obrigatória) | `market_indicator_lines.sort_order` | ordem das linhas da planilha |

Chave composta em todas as pontas: **`explicacao` + `linha`** — o mesmo
rótulo pode existir em explicações diferentes; duplicar o par dentro da mesma
explicação interrompe a carga. `unidade` deve ser igual em todas as linhas da
mesma explicação.

### De-para — fato de explicações

| SAC | Databricks (tabela explicacoes) | PostgreSQL `market_indicator_values` | Excel aba "Explicacoes" |
|---|---|---|---|
| Versão | `versao` | via `scenario_id` mensal | `versao` |
| Mês | `periodo` | via `scenario_id` | `periodo` |
| Membro Linha (`<explicacao>|<linha>`) | `explicacao` + `linha` (duas colunas) | `line_id` (junção com `market_indicator_lines`) | `explicacao` + `linha` |
| Medida valor | `valor` | `value` | `valor` |
| Medida kt | `kt` | `volume_kt` | `kt` (opcional) |

Unicidade: linha × versão × mês (no banco: `UNIQUE(line_id, scenario_id)`).

### Vínculos com itens do bridge

Tabela simples explicação → item do bridge (define quais itens abrem o
pop-up):

| Databricks (tabela itens) | PostgreSQL `market_indicator_items` | Excel aba "Itens" |
|---|---|---|
| `explicacao` | `indicator_id` (junção com `market_indicators`) | `explicacao` |
| `item` | `item` (rótulo do item do bridge, ex.: `Fines`) | `item` |

### Carga

Arquivo de referência com os dados atuais:
`exports/Explicacoes_Mercado_Bridge_EBITDA.xlsx` (abas "Linhas",
"Explicacoes", "Itens"). Importação:
`pnpm --filter @workspace/scripts run import-market-explanations [caminho.xlsx]`.
Sem a aba "Linhas", a fato pode trazer as propriedades em cada linha (formato
antigo); com as duas, conflitos interrompem a carga.

**Caminho Databricks → PostgreSQL: ainda não há importador direto para as
explicações** (o comando `import-databricks` cobre somente o Modelo 1).
Enquanto ele não existe, o caminho operacional é exportar as três tabelas do
Databricks para um `.xlsx` com abas "Linhas", "Explicacoes" e "Itens" nas
colunas acima (linhas ordenadas por `sort_order`) e rodar
`import-market-explanations` — as validações são as mesmas.

---

## Checklist de criação (resumo)

1. **Indicadores**: criar modelo com Versão + Tempo mensal + dimensão Item
   (propriedades `secao`, `moeda`, `atributo`, `grupo`, `sort_order`) +
   dimensão de conta Indicador; carregar membros da aba "Itens" e valores da
   aba "Indicadores" do export.
2. **Explicações**: criar modelo com Versão + Tempo mensal + dimensão Linha
   (chave composta `explicacao`+`linha`; propriedades `tipo`, `sentido`,
   `unidade`) e medidas `valor`/`kt`; carregar da aba "Linhas" e "Explicacoes".
3. **Databricks**: criar as tabelas espelhando as abas (uma linha da tabela =
   uma linha da aba), com `sort_order` nas tabelas de dimensão (itens e
   linhas); validar o Modelo 1 com o comando `import-databricks` e carregar o
   Modelo 2 via Excel enquanto não houver importador direto (ver seção de
   carga do Modelo 2).
4. Conferir no painel que o bridge fecha e as explicações batem com o SAC.
