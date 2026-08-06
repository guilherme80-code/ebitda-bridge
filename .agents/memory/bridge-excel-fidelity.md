---
name: EBITDA bridge Excel fidelity
description: Non-obvious rules from the "Cálculo" sheet needed to reproduce driver totals exactly
---
- The workbook uses TWO slightly different BRL/USD rates: general (E152/H152) and a fixed-cost-block rate (E125/H125). Model both or fixed cost drifts (~0.3 MUSD absorbed by the stock plug).
  **Why:** driver totals only match Excel exactly with the dedicated FC fx rate.
- New products (qty = 0 in one scenario) still carry reference unit prices/costs in Excel (D column falls back to the other scenario's price; unit var cost from the 50–80 block exists regardless of qty). Engine must fall back to the counterpart's unit price/cost, so new products generate only volume/mix and fx effects, never a fake price effect.
- The bridge decomposition is directional (target qty for price, source margins for vol/mix); reversing source/target closes but is not sign-symmetric — that matches the Excel methodology and is expected.
- Seed data for real scenarios (Budget/MRF7) must not get random jitter on fx — a ±1% fx jitter swings BRL price effects by thousands of kUSD because they are small differences of large numbers.
- Scenario "hasData" must require params AND sales rows; the stock-variation closing plug would otherwise make a partially imported scenario look like a valid, closed bridge.

## Estoque vs Outros vs Não Explicado
When the data brings Stock Variation misc facts, "Estoque" (data diff) and "Outros" (`sv_others`, relabeled) carry ONLY source values — no forced closure plug. The closure difference is a separate `discrepancy` field on the bridge result; routes emit an `unexplained` step ("Não Explicado") only when |discrepancy| ≥ 0.05 MUSD, and the explanations panel only appears then. Pairs without stock facts keep the single "Estoque / Outros" plug (closes by definition, discrepancy = 0). Simulation preserves `sv_others + discrepancy` as the invariant plug. **Why:** user's model — the source either justifies the passage or the gap must be surfaced honestly and explained. **How to apply:** closure math is start + drivers + discrepancy = end; the driver list is dynamic — routes filter/relabel based on whether `stock` exists in `drivers`; never assume a fixed driver set or that drivers alone close the bridge.
