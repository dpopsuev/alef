# Changelog

All notable changes to **`@dpopsuev/alef-ai`** are recorded here.

Release history before **[v0.0.1]** belongs to upstream **[Pi](https://github.com/earendil-works/pi-mono)** (`earendil-works/pi-mono`).

## [0.0.1] - 2026-05-10

### Added

- Built-in **Together AI** provider (`TOGETHER_API_KEY`).
- Routing for catalog **`anthropic`** models through **`@anthropic-ai/vertex-sdk`** when Anthropic Vertex / Google Cloud project and region are configured.

### Changed

- Initial **`@dpopsuev/alef-ai`** release from the **[alef](https://github.com/dpopsuev/alef)** fork baseline.

### Fixed

- OpenAI Responses: send **`reasoning.effort: "none"`** when thinking is disabled for models that support it.
- Claude on **Google Vertex**: routing works with **GCP ADC only** (no `ANTHROPIC_API_KEY` required when Vertex is configured); **`streamSimpleAnthropic`** no longer rejects missing keys in that case. Claude subscription OAuth and API-key auth do not block Vertex when standard Anthropic Vertex / Google Cloud env is present.
