# Changelog

All notable changes to `@dpopsuev/alef-organ-web` will be documented in this file.

## [0.0.1] - 2025-01-27

### Added
- `web.fetch` tool to fetch and read web pages as plain text or HTML
- `web.search` tool with multi-engine support (Brave, Tavily, Exa, DuckDuckGo)
- Automatic fallback chain for search engines based on available API keys
- Extensible search engine registry with `registerSearchEngine()`
- HTML-to-text conversion with script/style/nav stripping
- Comprehensive test suite with mocked and real integration tests
- Export `createOrgan` alias for materializer compatibility
