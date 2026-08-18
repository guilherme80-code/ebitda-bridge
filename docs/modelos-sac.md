# Roteiro — criação dos dois modelos no SAP SAC

Guia para criar no SAC os dois modelos que alimentam o painel Bridge de
EBITDA e replicá-los no Databricks. Contém, para cada modelo: dimensões com
chave e propriedades, medidas/contas, granularidade e o **de-para coluna a
coluna** entre SAC ↔ Databricks ↔ PostgreSQL ↔ arquivos de export (Excel).

Referências: `docs/fluxo-sac-databricks-app.md` (fluxo completo de ponta a
ponta, com a estrutura REAL dos modelos criados no SAC — `FOUND_EBITDA` e
`FOUND_EBITDA_EXPLANATIONS` — e as regras de extração),
`docs/modelo-indicadores.md` (contrato de importação) e
`docs/esquema-banco.md` (esquema físico do banco).

## Convenções comuns aos dois modelos

- **Granularidade: versão × mês.** Versões: `ACTUAL`, `BUDGET`,
  `MRF1`…`MRF12`; os IDs com zero à esquerda `MRF01`…`MRF09` são
  normalizados. O ano não é fixado em FY26: use o `YYYYMM` recebido do
  Databricks dentro do intervalo aceito (2000–2099). Ver
  `docs/fluxo-sac-databricks-app.md`.
  Períodos: somente meses, no padrão SAP SAC **`YYYYMM`** (ex.: `202601` =
  jan/2026). O formato antigo `JAN26`…`DEC26` continua aceito na importação.
  NÃO carregue FY nem trimestres — o painel deriva FY/Q somando meses (taxas
  entram como médias ponderadas).
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
| Dimensão **Versão** (category/version) | `ACTUAL`, `BUDGET`, `MRF1`…`MRF12` |
| Dimensão **Tempo** | Mensal, `YYYYMM` (ex.: `202601`…`202612`) |
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
| Dimensão **Versão** | `ACTUAL`, `BUDGET`, `MRF1`…`MRF12` |
| Dimensão **Tempo** | Mensal, `YYYYMM` (ex.: `202601`…`202612`) |
| Dimensão **Linha** (genérica, com propriedades) | Um membro por linha. **Decisão adotada no modelo real (`FOUND_EBITDA_EXPLANATIONS`): o ID do membro é o próprio rótulo da linha** (ex.: `Freight`), com a explicação na propriedade "Explanation EBITDA". **Premissa:** rótulos de linha globalmente únicos entre explicações. A alternativa com ID composto `<explicacao>|<linha>` (que dispensa a premissa) permanece válida caso rótulos repetidos venham a ser necessários — ver nota abaixo |
| Medidas | `valor` e `kt` (volume, opcional — só linhas de preço) |

Célula = Versão × Mês × Linha → valor (e kt quando aplicável). O impacto em
$m NÃO é armazenado: o painel calcula na leitura
(`preço`: sentido × Δvalor × kt, sem conversão de unidade — valor e kt devem
estar em escalas cujo produto já seja $m; `valor`: sentido × Δvalor).

### Dimensão "Linha" — propriedades

| Elemento SAC | Valores | Obrigatório |
|---|---|---|
| **ID do membro** | **Modelo real: o rótulo `linha` puro** (ex.: `Freight`), exigindo rótulos globalmente únicos entre explicações. Alternativa documentada: chave composta serializada `<explicacao>|<linha>` (ex.: `Iron Ores|Freight`), que admite rótulos repetidos (`Iron Ores|Freight` e `Coal|Freight` seriam membros distintos). Em ambos os casos **o caractere `|` é PROIBIDO em `explicacao` e em `linha`** (na forma composta, para a serialização ser injetiva); o importador rejeita valores com `|` nessas colunas | sim |
| **Description (rótulo exibido)** | o rótulo `linha` (ex.: `Freight`) | sim |
| propriedade `explicacao` (no modelo real: "Explanation EBITDA") | nome da explicação (ex.: `Iron Ores`) | sim |
| `tipo` | `preco` (valor é preço USD/t) \| `valor` (montante MUSD) | sim (padrão `preco`) |
| `sentido` | `1` (aumento melhora o EBITDA) \| `-1` (piora — custo) | sim (padrão `-1`) |
| `unidade` | unidade exibida (ex.: `Price $/t`) — igual para todas as linhas da mesma explicação | não |

**Nas pontas Databricks/Postgres/Excel a identidade da linha é o par
`explicacao` + `linha`** (duas colunas separadas) — duplicar o par dentro da
mesma explicação interrompe a carga. No SAC, o modelo real usa o rótulo puro
como ID (o que na prática também exige unicidade do rótulo entre explicações
— premissa registrada); a serialização composta no ID é a alternativa quando
rótulos repetidos forem necessários. A ordem das linhas na dimensão define a
ordem de exibição, e explicações aparecem na ordem da primeira linha.

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
| ID do membro (rótulo puro no modelo real; alternativa `<explicacao>|<linha>`) | `explicacao` + `linha` (duas colunas) | `market_indicators.title` + `market_indicator_lines.label` | `explicacao` + `linha` |
| propriedade `explicacao` ("Explanation EBITDA") | `explicacao` | `market_indicators.title` | `explicacao` |
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
| Membro Linha + propriedade `explicacao` | `explicacao` + `linha` (duas colunas) | `line_id` (junção com `market_indicator_lines`) | `explicacao` + `linha` |
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
   (ID = rótulo da linha, com a explicação em propriedade — ver decisão acima;
   propriedades `tipo`, `sentido`, `unidade`) e medidas `valor`/`kt`;
   carregar da aba "Linhas" e "Explicacoes".
3. **Databricks**: criar as tabelas espelhando as abas (uma linha da tabela =
   uma linha da aba), com `sort_order` nas tabelas de dimensão (itens e
   linhas); validar o Modelo 1 com o comando `import-databricks` e carregar o
   Modelo 2 via Excel enquanto não houver importador direto (ver seção de
   carga do Modelo 2).
4. Conferir no painel que o bridge fecha e as explicações batem com o SAC.
