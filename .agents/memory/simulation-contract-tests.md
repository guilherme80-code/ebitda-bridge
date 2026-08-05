---
name: Simulation contract tests
description: How the before-vs-simulated table contract is protected by tests in the api-server.
---

The pairing of simulated bridge tables with original values/`changed` flags is a pure helper (`buildSimulatedTables` in the api-server simulate lib), shared by the `/bridge/simulate` route and its vitest tests.

**Why:** the route itself needs DB + Anthropic, so testing the extracted pure function against the bundled seed JSON (same data used to seed prod) keeps the contract testable and automatically tracking the real data shape.

**How to apply:** when changing the simulate response shape or bridge table structure, update `buildSimulatedTables` (not inline route code) and run `pnpm --filter @workspace/api-server test`. Tests map the snake_case seed export to RawScenarioData; keep that mapping in sync if the schema changes.
