/**
 * Image generation type definitions
 */

import type { ImageContent, TextContent } from "./content.js";
import type { ImagesApi, ImagesProvider } from "./providers.js";
import type { ImagesStopReason, Usage } from "./usage.js";

/**
 *
 */
export type ImagesInputContent = TextContent | ImageContent;
/**
 *
 */
export type ImagesOutputContent = TextContent | ImageContent;

/**
 *
 */
export interface ImagesContext {
	input: ImagesInputContent[];
}

/**
 *
 */
export interface AssistantImages {
	api: ImagesApi;
	provider: ImagesProvider;
	model: string;
	output: ImagesOutputContent[];
	responseId?: string;
	usage?: Usage;
	stopReason: ImagesStopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

/**
 *
 */
export interface ImagesModel<TApi extends ImagesApi> {
	id: string;
	name: string;
	api: TApi;
	provider: ImagesProvider;
	baseUrl: string;
	input: ("text" | "image")[];
	output: ("text" | "image")[];
	cost: {
		input: number; // $/million tokens
		output: number; // $/million tokens
		cacheRead: number; // $/million tokens
		cacheWrite: number; // $/million tokens
	};
	headers?: Record<string, string>;
}
