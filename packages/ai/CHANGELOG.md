# Changelog

All notable changes to **`@alf-agent/ai`** are recorded here.

Release history before **[v0.0.1]** belongs to upstream **[Pi](https://pi.dev)** (`earendil-works/pi-mono`).

## [Unreleased]

### Fixed

- Claude on **Google Vertex** (`ALF_ANTHROPIC_VERTEX`): Vertex routing works with **GCP ADC only** (no `ANTHROPIC_API_KEY`); **`streamSimpleAnthropic`** no longer rejects missing keys when Vertex is configured. Claude subscription OAuth no longer blocks Vertex when the flag is set.

## [0.0.1] - 2026-05-10

### Added

- Built-in **Together AI** provider (`TOGETHER_API_KEY`).
- Opt-in routing for catalog **`anthropic`** models through **`@anthropic-ai/vertex-sdk`** when **`ALF_ANTHROPIC_VERTEX`** is set with GCP project, region, and credentials.

### Changed

- Initial **`@alf-agent/ai`** release from the **[alf-agent](https://github.com/dpopsuev/alf-agent)** fork baseline.

### Fixed

- OpenAI Responses: send **`reasoning.effort: "none"`** when thinking is disabled for models that support it.
