# Changelog

All notable changes to **`@alef/coding-agent`** (**`alef`**) are recorded here.

Release history before **[v0.0.1]** belongs to upstream **[Pi](https://github.com/earendil-works/pi-mono)** (`earendil-works/pi-mono`).

## [0.0.1] - 2026-05-10

### Breaking Changes

- Built-in tools renamed to **`file_*`** families (**`file_read`**, **`file_bash`**, **`file_edit`**, **`file_write`**, **`file_grep`**, **`file_find`**, **`file_ls`**) and **`symbol_outline`** (replaces the former **`symbols`** tool name). Update **`--tools`**, SDK allowlists, and extensions that matched legacy names.

### Added

- Built-in **`symbol_outline`** tool: structural outline for JavaScript/TypeScript (imports, exports, declarations, class members) via the TypeScript compiler API.
- Built-in **Together AI** provider wiring (`TOGETHER_API_KEY`) for **`/login`** and model resolution.
- **`docs/providers.md`** and **`alef --help`** document **`ALEF_ANTHROPIC_VERTEX`** and related GCP env vars for Claude on Vertex.

### Changed

- **`alef`** CLI, **`pkg.alef`** extension manifest field, **`alefConfig`** in **`package.json`**, and **`@alef/*`** packages. Optional version-check and telemetry defaults use **`ALEF_*`** environment variables instead of upstream **`pi`-centric endpoints**.

### Fixed

- macOS keybinding hints show **Option** instead of **Alt** where appropriate.
- Interactive update notification renders the changelog link as an **OSC 8** hyperlink when the terminal supports hyperlinks.
- Vertex docs and **`alef --help`**: **`ALEF_ANTHROPIC_VERTEX`** accepts **`true`** / **`yes`**; Anthropic API key is optional when Vertex is configured; OAuth does not disable Vertex when the flag is set.
