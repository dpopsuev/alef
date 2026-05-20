# @dpopsuev/alef-organ-fs

Filesystem organ runtime for cache policy and query acceleration.

This package provides:

- `InMemoryToolResultCache` and `ToolResultCache` contracts
- `FsRuntime` cache ownership for filesystem query scopes (`grep`, `find`, `ls`)
- query executors for `find`, `grep`, and `ls` with cache-aware responses
- optional no-op cache mode for deterministic cache-off behavior
