# @dpopsuev/alef-organ-code-intel

Code Intelligence organ runtime for semantic code perception.

This package provides:

- `CodeIntelRuntime` boot lifecycle (LSP probe + tree-sitter readiness flags)
- organ-level caches (`doc`, `ast`, `outline`, `graph`, `query`)
- domain-event hooks (`code.index.updated`, `code.cache.hit/miss`, `code.error`)
