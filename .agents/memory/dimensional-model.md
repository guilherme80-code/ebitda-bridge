---
name: Dimensional model (SAC) for indicators
description: Durable rules for the dim+fact restructure — why it exists and the invariants any future change must keep.
---

- The DB's canonical source is the dimensional model (item dimension + lean indicator fact); the old wide tables are legacy, receive no writes, and exist only so pre-restructure databases can be converted in place at startup.
- **Why:** mirrors the two SAP SAC models the user replicates in Databricks; an item is a global key whose properties must be identical across ALL scenarios — per-scenario property variation is invalid by design.
- **How to apply:** any importer/exporter must honor the two-part file contract (dimension sheet/table + lean fact) with back-compat for the old single-sheet format; when both carry properties, conflicts must abort, never win silently.
- Display order comes from the DIMENSION's row order, never from first appearance in the fact — sparse scenarios would silently reorder items otherwise.
- Startup must fail loudly (exit) if the dimensional data cannot be ensured; serving without it breaks every read. Runtime DDL for the new tables must stay additive and idempotent because publishing copies the schema only at publish time.
- Explanation lines are keyed by the COMPOSITE pair explicação + linha (never a globally unique label — the same label legitimately exists under different explicações, and forcing global uniqueness broke export of valid data).

## Período externo YYYYMM (padrão SAC)
- Contrato externo (Excel/Databricks/SAC) usa `periodo` em `YYYYMM` (ex.: 202601); formato antigo `JAN26..DEC26` segue aceito na importação e é normalizado.
- **Why:** SAC exige YYYYMM na dimensão de tempo; interno (`scenarios.period`, ids `fy26_m01_*`, rótulos do painel) permanece MMMYY — conversão só na borda (parse nos cores, `periodoParaYYYYMM` no export).
- **How to apply:** células YYYYMM podem chegar numéricas do Excel — trate número finito como string antes de validar; mês 00/13 e ano fora de 2000..2099 abortam a carga.
