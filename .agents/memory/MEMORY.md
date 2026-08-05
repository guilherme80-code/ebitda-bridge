# Memory index

- [EBITDA bridge Excel fidelity](bridge-excel-fidelity.md) — dual fx rates, zero-qty product fallback, directional decomposition, no fx jitter on real scenarios, hasData needs params+sales.
- [Production deploy gotchas](prod-deploy-gotchas.md) — publish copies schema not data; api-server auto-seeds from bundled JSON (re-export after dev re-import); CVE overrides for xlsx/transitives.
- [Simulation contract tests](simulation-contract-tests.md) — simTables pairing lives in a pure helper in simulate.ts; vitest tests in api-server feed it real seed JSON so tests track prod data shape.
- [Simulation AI provider](simulation-ai-provider.md) — Anthropic integration uses claude-sonnet-4-6; the Replit catalog does not list Sonnet 5.
