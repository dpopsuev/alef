# Changelog

## [0.0.1] - 2026-05-20

### Added

- File-based credential storage (`auth.ts`): reads/writes `~/.config/alef/auth.json`. `resolveApiKey()` checks stored keys before env vars. API key passed to `LLMOrgan` at startup.
- TUI session picker: on startup in TUI mode, shows a `SelectList` of recent sessions. Enter resumes, Escape starts new.
- `config.yaml` additions: `thinking` default level; `llm.maxRetries`, `llm.maxRetryDelayMs`, `llm.timeoutMs` forwarded to `LLMOrgan`.

### Changed

- `alef` binary now invokes the runner entry point (`packages/runner/src/main.ts`) instead of `packages/coding-agent/src/cli.ts`.
- Model resolution uses the full `@dpopsuev/alef-ai` registry. `buildModel()` accepts `provider/model-id` format. `autoDetectModel()` scans all known providers via `getEnvApiKey()` and picks the first with credentials. Removed hardcoded Anthropic/Ollama-only fallback.
- Fixed `tsconfig.json`: removed incorrect `rootDir` constraint and bumped `target` to `ES2024`.
