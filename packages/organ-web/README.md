# @dpopsuev/alef-organ-web

Web organ for Alef agents — fetch pages and search the web.

## Features

- **web.fetch**: Fetch web pages and convert to plain text or raw HTML
- **web.search**: Search the web with multiple engines (Brave, Tavily, Exa, DuckDuckGo)
- **No external dependencies**: Uses Node.js built-in `fetch`
- **Resilient**: Automatic fallback through search engines
- **Extensible**: Register custom search engines

## Installation

```bash
npm install @dpopsuev/alef-organ-web
```

## Usage

### Basic Setup

```typescript
import { createWebOrgan } from "@dpopsuev/alef-organ-web";

const webOrgan = createWebOrgan({
  defaultTimeoutMs: 15000, // optional
});
```

### In Agent Blueprints

Add to your `agent.yaml`:

```yaml
organs:
  - name: web
```

Or use the built-in alias in code:

```typescript
import { materializeBlueprint } from "@dpopsuev/alef-runner";

const result = await materializeBlueprint(definition, {
  cwd: process.cwd(),
});
// "web" resolves to @dpopsuev/alef-organ-web automatically
```

## Tools

### web.fetch

Fetch a web page and return its content as plain text or raw HTML.

**Parameters:**
- `url` (string, required): The URL to fetch. Must start with `http://` or `https://`.
- `format` (enum, optional): Output format. `"text"` (default) or `"html"`.
- `timeoutMs` (number, optional): Request timeout in milliseconds. Default: 15000.

**Returns:**
- `content` (string): The page content (plain text or HTML)
- `title` (string): Page title extracted from `<title>` tag
- `url` (string): Final URL after redirects
- `statusCode` (number): HTTP status code
- `truncated` (boolean): Whether content was truncated

**Example:**

```typescript
{
  type: "web.fetch",
  payload: {
    url: "https://example.com",
    format: "text",
    timeoutMs: 10000,
  }
}
```

### web.search

Search the web and return ranked results with URLs, titles, and snippets.

**Parameters:**
- `query` (string, required): The search query. Natural language questions work well.
- `numResults` (number, optional): Maximum number of results to return. Default: 10.
- `engine` (enum, optional): Specific search engine to use: `"brave"`, `"tavily"`, `"exa"`, or `"ddg"`. Omit to use auto-fallback.

**Returns:**
- `query` (string): The search query that was executed
- `results` (array): List of search results
  - `url` (string): Result URL
  - `title` (string): Result title
  - `snippet` (string): Short description from the search engine
  - `publishedAt` (string, optional): Publication date if available
- `hint` (string, optional): Guidance for next steps

**Example:**

```typescript
{
  type: "web.search",
  payload: {
    query: "TypeScript programming language",
    numResults: 5,
  }
}
```

## Search Engines

The organ supports multiple search engines with automatic fallback:

### Brave Search
- **Requires**: `BRAVE_SEARCH_API_KEY` environment variable
- **Docs**: https://brave.com/search/api/
- **Priority**: First in fallback chain

### Tavily Search
- **Requires**: `TAVILY_API_KEY` environment variable
- **Docs**: https://tavily.com/
- **Priority**: Second in fallback chain

### Exa Search
- **Requires**: `EXA_API_KEY` environment variable
- **Docs**: https://exa.ai/
- **Features**: Neural/semantic search
- **Priority**: Third in fallback chain

### DuckDuckGo Instant Answer
- **Requires**: No API key (free)
- **Docs**: https://duckduckgo.com/api
- **Priority**: Last resort fallback
- **Note**: Best-effort API, may return fewer results

## Fallback Behavior

When no `engine` is specified, `web.search` tries engines in this order:

1. **Brave** (if `BRAVE_SEARCH_API_KEY` is set)
2. **Tavily** (if `TAVILY_API_KEY` is set)
3. **Exa** (if `EXA_API_KEY` is set)
4. **DuckDuckGo** (always available, no key needed)

Each engine is tried until one returns results. If all return empty, the last error is thrown (or empty results returned).

## Environment Variables

```bash
# Optional: Set one or more for better search results
export BRAVE_SEARCH_API_KEY="your-brave-key"
export TAVILY_API_KEY="your-tavily-key"
export EXA_API_KEY="your-exa-key"

# DuckDuckGo requires no key
```

## Advanced Usage

### Custom Search Engine

You can register custom search engines:

```typescript
import { registerSearchEngine } from "@dpopsuev/alef-organ-web";
import type { ISearchEngine, SearchQuery, WebSearchResult } from "@dpopsuev/alef-organ-web";

class MySearchEngine implements ISearchEngine {
  async search(req: SearchQuery): Promise<WebSearchResult[]> {
    // Your implementation
    return [
      {
        url: "https://example.com",
        title: "Example",
        snippet: "Example snippet",
      },
    ];
  }
}

registerSearchEngine("my-engine", (key) => new MySearchEngine());
```

### Direct Search (Non-Organ Usage)

```typescript
import { webSearch, defaultSearchEngine } from "@dpopsuev/alef-organ-web";

// Quick one-off search
const results = await webSearch("TypeScript features", { numResults: 5 });

// Or use the engine directly
const engine = defaultSearchEngine();
const results2 = await engine.search({ query: "Alef agent framework", numResults: 10 });
```

## Testing

```bash
npm test                  # Unit tests (no network calls)
npm test -- search-integration.test.ts  # Integration tests (requires API keys)
```

## License

MIT
