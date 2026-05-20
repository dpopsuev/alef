# Changelog

## [0.0.1] - 2026-05-20

### Changed

- `alef` binary now invokes the runner entry point (`packages/runner/src/main.ts`) instead of `packages/coding-agent/src/cli.ts`.
- Model resolution uses the full `@dpopsuev/alef-ai` registry. `buildModel()` accepts `provider/model-id` format. `autoDetectModel()` scans all known providers via `getEnvApiKey()` and picks the first with credentials. Removed hardcoded Anthropic/Ollama-only fallback.
- Fixed `tsconfig.json`: removed incorrect `rootDir` constraint and bumped `target` to `ES2024`.
