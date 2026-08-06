---
name: Market explanations source
description: Conventions for the market explanations (Iron Ores-style) informational source and its importer/seed.
---

- Market explanations are informational only — they never enter bridge math. They attach to scenario *pair ids* (source→target), including derived FY/Q ids.
- **Derived ids are not in the `scenarios` table** (it holds monthly only; FY/Q are runtime-derived). Any catalog validation of `fy26_fy_*` / `fy26_q*_*` ids must check for at least one monthly scenario of the same year+version instead of exact id existence.
- **Why:** importer initially rejected valid FY pairs because it looked up derived ids directly.
- Seed backfill: when adding new tables that ship seed data, `seedIfEmpty` must also backfill them on an *already-seeded* prod DB (scenarios non-empty but new table empty), under the same advisory lock — otherwise upgrades ship empty features.
- Item ↔ explanation matching in the UI is by label, case-insensitive/trimmed.
