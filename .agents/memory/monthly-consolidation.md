---
name: Monthly source with derived FY/Q
description: EBITDA bridge source is monthly-only; FY/quarters are derived by aggregation ("consolidar primeiro")
---

# Monthly consolidation policy

The data source (sheet/Databricks) carries only monthly rows (JAN26..DEC26) per version (ACTUAL, BUDGET, MRF1..7; MRF01 style normalized). FY and quarter scenarios are NOT stored — the API derives them from months via a pure aggregation module (api-server `lib/aggregate.ts`).

**Why:** user chose "consolidar primeiro" — sum months and compute the bridge on totals (not month-by-month bridge summing). Rates become weighted averages: fx by domestic revenue, fixed-cost fx by BRL fixed costs, dmCostShare by cost, input price by consumption (yield×crude), yield by crude steel.

**How to apply:**
- Derived FY/Q keep the legacy ids (`fy26_fy_budget`, `fy26_q1_mrf3`) so URLs/default pair stay stable; a derived scenario has data only when ALL its months have data.
- Derived FY/Q are ALWAYS emitted (monthIds = all expected month ids, even absent ones); the catalog computes `missingMonths` for derived without data so the UI shows them disabled with the missing months listed — never let incomplete derived gain `hasData` or reach bridge computation.
- Cross-month classification of an item (sales currency/domestic, fixed USD flag, input priced vs direct amount) must be identical in all months — import rejects conflicts and aggregation throws as second defense. Never make aggregation "pick the first month".
- Tests build FY via `loadDerived()` in seed-fixture; FY driver values coincide with the old Excel reference because months sum to FY. Keep the numeric driver regression, not only plug-based closure (the stock plug always closes the bridge).
