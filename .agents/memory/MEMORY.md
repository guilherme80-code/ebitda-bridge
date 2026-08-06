# Memory index

- [EBITDA bridge Excel fidelity](bridge-excel-fidelity.md) — dual fx rates, zero-qty product fallback, directional decomposition, no fx jitter on real scenarios, hasData needs params+sales.
- [Production deploy gotchas](prod-deploy-gotchas.md) — publish copies schema not data; api-server auto-seeds from bundled JSON (re-export after dev re-import); CVE overrides for xlsx/transitives.
- [Simulation contract tests](simulation-contract-tests.md) — simTables pairing lives in a pure helper in simulate.ts; vitest tests in api-server feed it real seed JSON so tests track prod data shape.
- [Databricks import](databricks-import.md) — Excel & Databricks importers share one validation core; databricks-m2m connector is catalog-only until user configures it in Settings; live run untested.
- [Grouped detail tables](grouped-tables.md) — grupo column is data-driven (never hardcode); group header = subtotal row before members; new fact columns must propagate to core/export/databricks/seed/openapi in lockstep.
- [Simulation AI provider](simulation-ai-provider.md) — Anthropic integration uses claude-sonnet-4-6; the Replit catalog does not list Sonnet 5.
- [Market explanations source](market-explanations.md) — informational pop-up tables keyed by pair id; derived FY/Q ids aren't in scenarios table; seed must backfill new tables on upgraded prod DBs.
- [Monthly source with derived FY/Q](monthly-consolidation.md) — source is monthly-only; FY/Q derived by summing months with weighted rates; cross-month classification conflicts must be rejected, never first-month-wins.
