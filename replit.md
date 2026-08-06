# Painel Bridge de EBITDA

Painel executivo que explica a variação de EBITDA (FY26 Budget 632,0 → FY26 MRF7 747,7 MUSD) em um gráfico de cascata interativo com drill-down por componente. Interface em português (pt-BR).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/bridge-ebitda run dev` — run the web frontend
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/scripts run import-bridge` — reimport bridge data from the Excel in `attached_assets/`
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Frontend: React + Vite + Tailwind + Recharts (waterfall custom via ranged bars)
- Build: esbuild (CJS bundle)

## Where things live

- OpenAPI contract: `lib/api-spec/openapi.yaml` (endpoints `/scenarios`, `/bridge`, `/bridge/components/{key}`, `/bridge/summary`; bridge endpoints aceitam `?source=&target=` com ids de cenário)
- DB schema: `lib/db/src/schema/bridge.ts` (`scenarios`, `bridges`, `bridge_components`, `bridge_detail_lines`)
- API routes: `artifacts/api-server/src/routes/bridge.ts`
- Importer do Excel: `scripts/src/import-bridge.ts` (lê a aba "Cálculo" do xlsx via `xlsx`)
- Frontend: `artifacts/bridge-ebitda/src/` (Dashboard, WaterfallChart, DrillDownDrawer, SummaryCards)

## Architecture decisions

- Dados vêm do banco (importados do Excel via script), nunca hardcoded no frontend; valores em MUSD.
- Componentes do waterfall seguem a ordem da aba "Bridge" do Excel; Volume & Mix e Estoque/Outros são agregados com decomposição no drill-down.
- Drill-downs por produto incluem uma linha "Demais itens e ajustes" para que a soma sempre feche exatamente com o valor do componente.
- Zod integers evitados no OpenAPI (`type: number`) — `zod.int()` gerado pelo Orval não existe no zod v3 importado pelo pacote gerado.
- Recharts: labels de valor são desenhados dentro do shape customizado da barra (o prop `label` do Bar não recebe `payload` no Recharts 2).
- Interface do painel em inglês (tradução fixa, sem i18n dinâmico). Formato numérico en-US (ponto decimal, ex.: 12.5) aplicado em toda a UI via `Intl.NumberFormat('en-US')`; a entrada de valores no painel de explicações aceita vírgula ou ponto.

## User preferences

- Usuário fala português (Brasil) e é da área de negócios/finanças — comunicar sem jargão técnico.
