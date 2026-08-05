---
name: Production deploy gotchas
description: Lessons from publishing the EBITDA bridge (security scan blocks, empty prod DB, auto-seed).
---

- Publish security scan blocks builds on high CVEs. Fixed via pnpm overrides in root package.json (transitives pinned; `xlsx` replaced with SheetJS CDN tarball 0.20.3 because npm's 0.18.5 has unfixed CVEs).
- Publishing copies the dev DB **schema only, not data** — first prod boot had empty tables and /api/scenarios returned 404 (route 404s when catalog is empty).
- **Why/How:** api-server now auto-seeds on startup when `scenarios` is empty, from a bundled JSON dump (`src/seed/bridge-seed.json`, exported from dev DB) inside a transaction guarded by `pg_advisory_xact_lock` + re-check (autoscale boots concurrent instances). Seed is awaited before `app.listen`. If bridge data is re-imported in dev, re-export the seed JSON before publishing.
- User must click Publish themselves; agent cannot deploy.
