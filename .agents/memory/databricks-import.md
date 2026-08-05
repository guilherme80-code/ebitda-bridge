---
name: Databricks indicadores import
description: How the panel imports indicadores straight from Databricks and the connector caveat
---

- The Excel (aba única) and Databricks importers share one validation core; any format rule change must land there, not in either entrypoint, or the two sources drift.
- The Replit `databricks-m2m` connector was catalog-only (`connector_catalog:` id, "requires setup") — it cannot be proposed via ProposeIntegration until the user configures it in workspace Settings → Connectors. The import script therefore fetches credentials at runtime from the connectors proxy and fails with a clear "configure the connector" message when absent.
- **Why:** live Databricks connection could not be tested at build time; the credential-field names (host/token/warehouse) are read defensively and may need adjustment on first real run.
- **How to apply:** when the user says the connector is configured, run `pnpm --filter @workspace/scripts run import-databricks <catalogo.schema.tabela>` and fix field mapping if credentials resolve oddly; warehouse id fallback is `DATABRICKS_WAREHOUSE_ID`.
