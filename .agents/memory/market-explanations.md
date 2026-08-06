---
name: Market explanations source
description: Conventions for the market explanations (Iron Ores-style) informational source and its importer/seed.
---

- Explanations (renamed from "market explanations" in the UI) are informational only — they never enter bridge math. They are stored per *monthly* pair id only; the importer rejects FY/Q periods, and the read API expands an FY/Q pair into month pairs (month i ↔ month i), sums impacts/kt, and returns per-month detail. Price columns are only meaningful for single-month pairs.
- **Never truncate** when zipping source/target month intervals: mismatched granularities (FY × Q) must be a 400, not a partial sum.
- Seed backfill: when adding new tables that ship seed data, `seedIfEmpty` must also backfill them on an *already-seeded* prod DB (scenarios non-empty but new table empty), under the same advisory lock — otherwise upgrades ship empty features. It also migrates legacy FY-keyed explanation rows to the monthly seed, but never touches data already in the monthly format.
- Item ↔ explanation matching in the UI is by label, case-insensitive/trimmed.
