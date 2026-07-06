import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";

import { formatThrownValue } from "../../utils/diagnostics.js";

// ============================================================================
// Configuration
// ============================================================================

export const MAX_RETRIES = 3;
export const BASE_DELAY_MS = 1000;

export type CodexResponseStatus = "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";

export const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"queued",
	"in_progress",
]);

// ============================================================================
// Error Classes
// ============================================================================

export class CodexApiError extends Error {
	readonly code?: string;
	readonly payload?: Record<string, unknown>;

	constructor(message: string, options?: { code?: string; payload?: Record<string, unknown>; cause?: unknown }) {
		super(message);
		this.name = "CodexApiError";
		this.code = options?.code;
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

export class CodexProtocolError extends Error {
	readonly payload?: unknown;

	constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
		super(message);
		this.name = "CodexProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

export function isCodexNonTransportError(error: unknown): boolean {
	return error instanceof CodexApiError || error instanceof CodexProtocolError;
}

// ============================================================================
// Retry Helpers
// ============================================================================

export function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		});
	});
}

// ============================================================================
// SSE Parsing
// ============================================================================

export async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stream reader loop exits via break
		while (true) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- ReadableStream reader boundary
			const { done, value } = await reader.read();
			if (done) break;
			// eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- ReadableStream value boundary
			buffer += decoder.decode(value, { stream: true });

			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);

				const dataLines = chunk
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5).trim());
				if (dataLines.length > 0) {
					const data = dataLines.join("\n").trim();
					if (data && data !== "[DONE]") {
						try {
							// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse boundary
							yield JSON.parse(data) as Record<string, unknown>;
						} catch (cause) {
							throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
								cause,
								payload: data,
							});
						}
					}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

// ============================================================================
// Error Response Parsing
// ============================================================================

export async function parseErrorResponse(response: Response): Promise<{ message: string; friendlyMessage?: string }> {
	const raw = await response.text();
	let message = raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;

	try {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse boundary
		const parsed = JSON.parse(raw) as {
			error?: { code?: string; type?: string; message?: string; plan_type?: string; resets_at?: number };
		};
		const err = parsed.error;
		if (err) {
			// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through
			const code = err.code || err.type || "";
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
				const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
				const mins = err.resets_at
					? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
					: undefined;
				const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}
			// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through
			message = err.message || friendlyMessage || message;
		}
	} catch {}

	return { message, friendlyMessage };
}

// ============================================================================
// Event Mapping
// ============================================================================

export async function* mapCodexEvents(events: AsyncIterable<Record<string, unknown>>): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "error") {
			const code = (event as { code?: string }).code ?? "";
			const message = (event as { message?: string }).message ?? "";
			throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
				code: code || undefined,
				payload: event,
			});
		}

		if (type === "response.failed") {
			const response = (event as { response?: { error?: { code?: string; message?: string } } }).response;
			const code = response?.error?.code;
			const message = response?.error?.message;
			throw new CodexApiError(message ?? "Codex response failed", { code, payload: event });
		}

		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = (event as { response?: { status?: unknown } }).response;
			const normalizedResponse = response
				? { ...response, status: normalizeCodexStatus(response.status) }
				: response;
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Codex event type mapping
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Codex event type mapping
			yield { ...event, type: "response.completed", response: normalizedResponse } as ResponseStreamEvent;
			return;
		}

		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Codex event type mapping
		yield event as unknown as ResponseStreamEvent;
	}
}

export function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
	if (typeof status !== "string") return undefined;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by Set.has check above
	return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus) ? (status as CodexResponseStatus) : undefined;
}
