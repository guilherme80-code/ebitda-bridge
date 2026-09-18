# Instalação e desenvolvimento local

Os comandos são os mesmos no terminal do Codex, do VS Code ou fora de uma IDE.
Não é necessário Git Bash ou WSL para instalar as dependências ou executar os
scripts dos pacotes.

## Versões

- Node.js **24.19.0**, versão de referência em `.node-version`. O campo
  `engines.node` aceita atualizações posteriores da linha 24.
- pnpm **10.33.4**, fixado em `packageManager` e `engines.pnpm` na raiz.

Instale o Node.js antes de continuar. `.node-version` documenta a versão para
gerenciadores compatíveis; o arquivo não instala o Node automaticamente.
Não use npm ou Yarn para instalar as dependências do monorepo.

## Instalação no PowerShell

Na raiz do repositório, confira o Node e use o Corepack, quando disponível:

```powershell
node --version
corepack enable pnpm
pnpm.cmd --version
pnpm.cmd install --frozen-lockfile
```

O Corepack seleciona a versão declarada em `packageManager`. A habilitação
pode exigir permissão para escrever na pasta do Node. O comando `pnpm`
precisa estar no PATH: os scripts agregados o chamam internamente; usar apenas
`corepack pnpm` sem habilitar o shim não basta para esses scripts.

Se o Corepack não estiver disponível ou o shim não puder ser habilitado,
instale apenas o gerenciador via npm:

```powershell
npm.cmd install --global pnpm@10.33.4
pnpm.cmd --version
pnpm.cmd install --frozen-lockfile
```

No Windows, os comandos `.cmd` também evitam depender da política de execução
de scripts `.ps1`. Nos comandos abaixo, `pnpm` pode ser substituído por
`pnpm.cmd` no Windows. No Linux/macOS, use `pnpm`, sem o sufixo `.cmd`.

A instalação requer acesso ao registro npm e ao CDN SheetJS referenciado no
lockfile. O preinstall valida o uso do pnpm sem apagar outros lockfiles.

## Configuração do ambiente

Na raiz do repositório, crie o arquivo local somente se ele ainda não existir:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

O `.env.example` não contém credenciais. O `.env` fica ignorado pelo Git;
nunca coloque senhas ou tokens em variáveis com prefixo `VITE_`.

- API (`dev` e `start`) e comandos operacionais de `@workspace/scripts`
  carregam o `.env` da raiz com `--env-file-if-exists` do Node 24, antes de
  importar o código. Isso funciona também com `pnpm --filter`.
- Variáveis já definidas no terminal têm precedência sobre o `.env`.
  Não é necessário exportá-las manualmente nem instalar `dotenv`.
- O frontend lê o mesmo diretório com `loadEnv` do Vite. O Vite também aceita
  `.env.local` e arquivos por modo; para manter backend e scripts consistentes,
  use somente `.env` neste fluxo local, sem interpolação de variáveis.
- Build, typecheck e testes não precisam de chaves Anthropic/OpenAI.
  `pnpm test` não carrega `.env` e força uma URL fictícia de banco e
  `RUN_DB_INT_TESTS=0`, mesmo se o terminal tiver outros valores.

| Variável | Uso local |
|---|---|
| `FRONTEND_PORT` | Porta do Vite; padrão `5173` |
| `API_PORT` | Porta da API e destino do proxy; padrão `3000` em desenvolvimento |
| `BASE_PATH` | Base do frontend principal; padrão `/` |
| `LOG_LEVEL` | Nível dos logs da API; padrão `info` |
| `DATABASE_URL` | Conexão PostgreSQL; preencher apenas após preparar a base local |
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` e `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | Ainda obrigatórias para iniciar a API atual |
| `AI_INTEGRATIONS_OPENAI_*` | Opcionais; sem uso nas rotas atuais |
| `DATABRICKS_*` | Opcionais; somente para o importador, cuja autenticação ainda depende do Replit |

`PORT` continua aceito por processo, com precedência sobre `API_PORT` ou
`FRONTEND_PORT`, para preservar a configuração Replit. Não defina um `PORT`
global no `.env` ou no terminal ao iniciar ambos os serviços: isso faria os
dois disputarem a mesma porta. Para limpar um valor herdado no PowerShell:

```powershell
Remove-Item Env:PORT -ErrorAction SilentlyContinue
```

O comando `dev` da API define `NODE_ENV=development`. Em produção, a API
continua exigindo uma porta explícita (`PORT` ou `API_PORT`).

## Comandos na raiz

| Comando | Resultado |
|---|---|
| `pnpm dev:web` | Inicia somente o frontend em `http://localhost:5173` |
| `pnpm dev:api` | Compila e inicia somente a API em `http://localhost:3000` |
| `pnpm dev` | Inicia API e frontend em paralelo |
| `pnpm test` | Executa as suítes não destrutivas, sem usar credenciais de banco |
| `pnpm typecheck` | Verifica os tipos de todos os pacotes |
| `pnpm build` | Verifica tipos e compila API, frontend e sandbox |

O frontend continua chamando caminhos relativos `/api`. Durante o
desenvolvimento, Vite encaminha esses pedidos para `http://localhost:3000`
(ou a porta `API_PORT` configurada), mantendo caminho e query string.
Não há URL absoluta do backend no código do dashboard. Esse proxy não é
configuração de hospedagem de produção nem do comando `vite preview`.

### Verificações que não iniciam a API

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd test
pnpm.cmd typecheck
pnpm.cmd build
```

Não é necessário definir `PORT`, `BASE_PATH`, conexão real de banco ou
credenciais de IA para essas verificações. Os testes dos importadores ainda
carregam o módulo de banco, mas não o consultam; o comando da raiz fornece
uma URL fictícia. Os três testes destrutivos de seed permanecem desabilitados.

### Desenvolvimento após preparar banco e credenciais

**Não execute `dev:api` ou `dev` contra um banco real nesta etapa de migração.**
A inicialização existente ainda executa seed/conversões automaticamente.
Após a etapa de banco, com uma base local preparada e Anthropic configurada:

```powershell
pnpm.cmd dev
```

Ou use dois terminais na raiz:

```powershell
# Terminal 1, somente depois de preparar a API:
pnpm.cmd dev:api

# Terminal 2:
pnpm.cmd dev:web
```

Abra `http://localhost:5173`. Encerre com Ctrl+C nos terminais utilizados.
Executar apenas `dev:web` é possível agora, mas as consultas `/api` falharão
enquanto o backend não estiver disponível; isso não representa dados vazios.

O comando de desenvolvimento da API continua compilando e iniciando uma vez,
sem modo watch. Reinicie-o depois de alterar o backend. O frontend usa o HMR
do Vite. O sandbox não é iniciado por `pnpm dev`; seus padrões independentes
são porta `8081` e base `/__mockup`, suficientes também para o build geral.

### VS Code e Codex

Abra a pasta raiz `EBITDA-Bridge`, não apenas um workspace de `artifacts`.
No VS Code, abra **Terminal → Novo Terminal**, selecione PowerShell e use os
mesmos comandos acima. Confirme `node --version` e `pnpm.cmd --version` no
terminal integrado. O mesmo procedimento vale para o terminal do Codex.
Nenhuma extensão, tarefa de IDE ou configuração exclusiva do editor é necessária.

## Comandos por pacote

```text
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/bridge-ebitda run test
pnpm --filter @workspace/scripts run test
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/bridge-ebitda run dev
```

Prefira `pnpm test` na raiz para garantir o ambiente de testes isolado. Os
comandos individuais de teste permanecem disponíveis, mas não aplicam a
proteção do lançador da raiz e não carregam automaticamente `.env`.

## Limites desta etapa

Ainda será necessário preparar a execução completa fora do Replit:

- Preparar o schema e revisar o seed/conversões antes de iniciar a API.
  Copiar `.env.example` não cria banco nem torna a API pronta para iniciar.
- Não habilite `RUN_DB_INT_TESTS=1` contra dados reais: os testes de integração
  removem dados e tabelas. Use uma base descartável na etapa de banco.
- A API importa o cliente Anthropic ao carregar as rotas e exige URL e chave
  mesmo para o dashboard sem simulação. Essa dependência de inicialização
  permanece para a etapa de IA; não use credenciais fictícias para contorná-la.
- A autenticação Databricks permanece dependente do proxy de conectores Replit.
- Comandos Drizzle e importadores gravam no banco. Nenhum deles é executado
  pela instalação, testes da raiz, typecheck ou build.
- O hook `scripts/post-merge.sh` continua específico do Replit e não faz parte
  da instalação local. Ele aplica schema de banco e não deve ser executado
  como parte desta etapa.
- Os overrides de segurança da raiz foram preservados. No YAML, somente as
  exclusões de binários Windows foram retiradas; as demais regras permanecem.

Referência: [instalação e compatibilidade do pnpm 10](https://pnpm.io/10.x/installation).
