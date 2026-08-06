---
name: Grupos nas tabelas detalhadas
description: Convenção da coluna grupo/group_label e das linhas de grupo nas tabelas do bridge
---

Rule: item grouping in the detailed tables (Blacks/Reds/Alloys, Controllable/Non-controllable, etc.) is data-driven via the optional `grupo` column in the single-sheet source, persisted as nullable `group_label` on the fact tables. Never hardcode classifications in code — the user adjusts them in the spreadsheet/Databricks table.

**Why:** the user explicitly chose an editable group column over fixed code mapping; groups must survive export→import round-trips and the Databricks import (which falls back to querying without `grupo` when the column doesn't exist).

**How to apply:**
- Table rows carry `group`; a `kind: "subtotal"` row with `group` set is the group header (values = sum of members) emitted BEFORE its detail rows; ungrouped rows come last without a header. Sales rows without grupo fall back to Externo/Mercado Interno buckets.
- Frontend collapses group detail by default ("detalhe ao clicar"); simulation-changed rows stay visible even in a collapsed group.
- Any new column on the fact tables must be added in lockstep to: indicadores-core (validate + inserts), export-indicadores, import-databricks column list, api-server seed.ts mapper + regenerated bridge-seed.json, and the OpenAPI spec + orval codegen if it reaches the API.
