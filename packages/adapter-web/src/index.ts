export type { ISearchEngine, SearchQuery, WebSearchResult } from "@dpopsuev/web-spider";
// Search utilities — re-exported from web-spider for backward compatibility.
export {
	defaultSearchEngine,
	registerSearchEngine,
	webSearch,
} from "@dpopsuev/web-spider";
export type { WebOrganOptions } from "./adapter.js";
export { createWebOrgan, createWebOrgan as createOrgan } from "./adapter.js";
