import type { AssistantMessage, Message } from "@dpopsuev/alef-ai/types";

/** Return true if the error message indicates a transient failure eligible for retry. */
function isRetryableError(msg: string | undefined): boolean {
	if (!msg) return false;
	// Anthropic SDK APIConnectionTimeoutError.message = "Request timed out."
	if (/timed[\s_]?out/i.test(msg)) return true;
	// Anthropic API 529
	if (msg.includes("overloaded_error")) return true;
	// Network layer drops
	if (/network[\s_]connection[\s_]lost/i.test(msg)) return true;
	// TCP connect failure
	if (/connection[\s_]?(?:timed[\s_]?out|error)/i.test(msg)) return true;
	// HTTP 503
	if (/service[\s_]unavailable/i.test(msg)) return true;
	// HTTP 500
	if (/internal[\s_]server[\s_]error/i.test(msg)) return true;
	// HTTP 429 / Vertex RESOURCE_EXHAUSTED
	if (/429|rate[\s_]limit|too[\s_]many[\s_]requests|resource[\s_]exhausted|quota[\s_]exceeded/i.test(msg)) return true;
	return false;
}

/** Return true if the assistant error is transient and retries remain. */
export function shouldRetry(msg: AssistantMessage, retryCount: number, maxRetries: number): boolean {
	return (
		msg.stopReason === "error" &&
		typeof msg.errorMessage === "string" &&
		isRetryableError(msg.errorMessage) &&
		retryCount < maxRetries
	);
}

/** Compute exponential backoff delay in milliseconds, capped at maxDelayMs. */
export function retryDelayMs(attempt: number, maxDelayMs: number): number {
	return Math.min(1_000 * 2 ** (attempt - 1), maxDelayMs);
}

/** Promise-based sleep for retry backoff delays. */
// lint-ignore: RAWTIMER retry backoff sleep, not a deadline or stall detector
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ensure a raw message has a timestamp and wrap bare-string assistant content in a text block. */
export function normalizeMessage(m: unknown): Message {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- casting untyped bus payload for field access
	const raw = m as Record<string, unknown>;
	const withTs: Record<string, unknown> = typeof raw.timestamp === "number" ? raw : { ...raw, timestamp: Date.now() };
	if (withTs.role === "assistant" && typeof withTs.content === "string") {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- reconstructing Message from untyped payload
		return { ...withTs, content: [{ type: "text", text: withTs.content }] } as unknown as Message;
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- casting validated payload to Message
	return withTs as unknown as Message;
}
