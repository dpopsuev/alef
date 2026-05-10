# Changelog

All notable changes to **`@alef/ai`** are recorded here.

Release history before **[v0.0.1]** belongs to upstream **[Pi](https://github.com/earendil-works/pi-mono)** (`earendil-works/pi-mono`).

## [0.0.1] - 2026-05-10

### Added

- Built-in **Together AI** provider (`TOGETHER_API_KEY`).
- Opt-in routing for catalog **`anthropic`** models through **`@anthropic-ai/vertex-sdk`** when **`ALEF_ANTHROPIC_VERTEX`** is set with GCP project, region, and credentials.

### Changed

- Initial **`@alef/ai`** release from the **[alef](https://github.com/dpopsuev/alef)** fork baseline.

### Fixed

- OpenAI Responses: send **`reasoning.effort: "none"`** when thinking is disabled for models that support it.
- Claude on **Google Vertex** (`ALEF_ANTHROPIC_VERTEX`): routing works with **GCP ADC only** (no `ANTHROPIC_API_KEY` required when Vertex is configured); **`streamSimpleAnthropic`** no longer rejects missing keys in that case. The env flag accepts **`1`**, **`true`**, or **`yes`**. Claude subscription OAuth does not block Vertex when the flag is set.
