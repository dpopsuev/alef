# @dpopsuev/alef-organ-lector

Lector organ runtime for semantic code perception.

This package provides:

- `LectorRuntime` boot lifecycle (LSP probe + tree-sitter readiness flags)
- organ-level caches (`doc`, `ast`, `outline`, `graph`, `query`)
- domain-event hooks (`lector.index.updated`, `lector.cache.hit/miss`, `lector.error`)
