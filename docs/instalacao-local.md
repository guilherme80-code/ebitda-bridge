# Instalação local — etapa de portabilidade

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

## Comandos existentes

```text
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/bridge-ebitda run test
pnpm --filter @workspace/scripts run test
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/bridge-ebitda run dev
```

O comando de desenvolvimento da API continua compilando e iniciando uma vez,
sem modo watch. O lançador Node define `NODE_ENV=development` tanto para o
build quanto para o servidor, interrompendo a execução se o build falhar.

## Limites desta etapa

Esta etapa torna a instalação e os scripts portáteis; ainda não configura a
execução completa fora do Replit:

- O build dos frontends exige `PORT` e `BASE_PATH`. Para verificar o build
  completo no PowerShell, sem iniciar serviços:

  ```powershell
  $env:PORT = "23808"
  $env:BASE_PATH = "/"
  pnpm run build
  ```

  Esses valores são para a verificação do build. Na execução simultânea, cada
  serviço precisa de sua própria porta e o sandbox usa a base `/__mockup`.
- Os testes dos importadores carregam o módulo de banco e exigem uma
  `DATABASE_URL`, embora os testes de validação não consultem o banco.
- Não habilite `RUN_DB_INT_TESTS=1` contra dados reais: os testes de integração
  removem dados e tabelas. Use uma base descartável na etapa de banco.
- A API ainda exige PostgreSQL preparado, `PORT` e as variáveis Anthropic.
  Iniciá-la executa o seed/conversões existentes. A integração Databricks e o
  roteamento entre frontend e API serão tratados em etapas posteriores.
- O hook `scripts/post-merge.sh` continua específico do Replit e não faz parte
  da instalação local. Ele aplica schema de banco e não deve ser executado
  como parte desta etapa.
- Os overrides de segurança da raiz foram preservados. No YAML, somente as
  exclusões de binários Windows foram retiradas; as demais regras permanecem.

Referência: [instalação e compatibilidade do pnpm 10](https://pnpm.io/10.x/installation).
