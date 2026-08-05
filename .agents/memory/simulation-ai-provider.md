---
name: Simulation AI provider
description: Model/provider decision for the EBITDA what-if prompt interpreter.
---

The EBITDA scenario simulator uses Replit AI Integrations for Anthropic with `claude-sonnet-4-6`. “Sonnet 5” is not listed as an available model in the integration catalog, so Sonnet 4.6 is the supported closest choice.

**Why:** The user requested Anthropic Sonnet; using an unlisted model would make the simulation fail with the managed integration.

**How to apply:** Keep the simulation on the supported Anthropic client/model unless the integration catalog changes or the user explicitly chooses another available model.