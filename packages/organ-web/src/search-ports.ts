/**
 * Port interfaces for web search engines.
 *
 * No concrete imports. Adapters implement these; the core orchestrates them.
 * Design follows Hexagonal Architecture: ports define contracts, adapters
 * implement them, and the organ routes between them.
 */

// ---------------------------------------------------------------------------
// ISearchEngine
// ---------------------------------------------------------------------------

export interface SearchQuery {
	query: string;
	numResults?: number;
}

/**
 * A single result from a web search engine.
 * Defined here so port interfaces have no dependency on adapter modules.
 */
export interface WebSearchResult {
	url: string;
	title: string;
	/** Short description or snippet from the search engine. */
	snippet: string;
	/** ISO-8601 or human-readable date, if the engine returned one. */
	publishedAt?: string;
}

/**
 * Web search engine port.
 * Adapters: BraveSearchEngine, TavilySearchEngine, ExaSearchEngine, DdgSearchEngine.
 * Swap for tests: stub returning fixed results.
 */
export interface ISearchEngine {
	search(req: SearchQuery): Promise<WebSearchResult[]>;
}
