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

## Estoque vs Outros
When the data brings Stock Variation misc facts, the bridge splits the old single plug into a real "Estoque" driver (data diff) plus an "Outros" residual plug (`sv_others`, relabeled "Outros"). Pairs without stock facts keep the single "Estoque / Outros" plug. **Why:** keeps the "Não Explicado" residual precise while staying backward compatible. **How to apply:** the driver list is dynamic — routes filter/relabel based on whether `stock` exists in `drivers`; never assume a fixed driver set.
