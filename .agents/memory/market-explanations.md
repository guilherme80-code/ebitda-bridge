---
name: Market explanations source
description: Conventions for the explanations (Iron Ores-style) informational source, per-version storage, importer and seed conversion.
---

- Explanations are informational only — they never enter bridge math. Storage is per VERSION and monthly scenario (`market_indicators` / `_lines` / `_values` / `_items`): each line stores a value (+ optional kt) per monthly scenario id; the scenario difference and impact are computed at read time after pair selection, so any valid pair works. Impact rule: price lines = direction × (target − source) × kt **of the target month only (no source fallback)**; amount lines (MUSD) = direction × (target − source). Amount lines never expose price columns in the response.
- Read API expands FY/Q pairs into month pairs (month i ↔ month i), sums impacts/kt, returns per-month detail; price columns only for single-month pairs. **Never truncate** mismatched granularities (FY × Q) — that's a 400, not a partial sum.
- Legacy per-pair tables (`market_explanations*`, precomputed var/impact) are kept in schema; `seedIfEmpty` converts them in-DB to the per-version format under the seed advisory lock (new tables non-empty → noop; legacy monthly rows → convert via `convertLegacyMarketExplanations`; else seed new-format JSON). Conversion must abort loudly on: conflicting values for same line/scenario, opposite inferred directions, or amount impacts not representable as per-scenario levels (chained pairs). Inferred direction (from effective diff × impact) overrides the −1 default set by zero-variance months.
- Importer sheet contract is per version/month: versao | periodo (monthly only) | explicacao | linha | valor | kt? | tipo? (preco/valor) | sentido? (±1, default −1) | unidade?; Itens keyed by explicacao+item. Import replaces the new tables AND clears the legacy ones transactionally.
- Item ↔ explanation matching in the UI is by label, case-insensitive/trimmed.
