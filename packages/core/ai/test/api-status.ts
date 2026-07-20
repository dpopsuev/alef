/**
 * Distinguishes "the provider rejected us for quota/rate-limit reasons" (429/503/529 —
 * request was valid, we just can't afford it right now) from "our request was actually
 * malformed or unauthenticated" (4xx auth/shape errors — a real regression).
 *
 * Integration tests use this to assert they made a *valid* API call without requiring
 * a paid subscription: a quota rejection proves the request reached the provider,
 * passed auth, and was well-formed, so the test can be skipped rather than failed.
 */

import type { TestContext } from "vitest";
import type { ProviderResponse } from "../src/types/options.js";

const QUOTA_STATUS_CODES = new Set([429, 503, 529]);

// Not every provider wires `onResponse` (Google's, e.g., doesn't), so the HTTP
// status is often unavailable. Fall back to sniffing the provider's own error
// text for well-known quota/rate-limit phrasing.
//
// Also covers OpenRouter's free-tier churn: model IDs get quietly de-listed
// from the free catalog or capacity-capped ("no endpoints found", "unavailable
// for free", "local total request limit reached") independent of our request
// being valid — same class of "can't afford it right now" as a quota error.
const QUOTA_MESSAGE_PATTERNS = [
	/\b429\b/,
	/rate.?limit/i,
	/resource.?exhausted/i,
	/too many requests/i,
	/exceeded your current quota/i,
	/quota exceeded/i,
	/unavailable for free/i,
	/no endpoints found/i,
	/request limit reached/i,
];

export function isQuotaStatus(status: number | undefined): boolean {
	return status !== undefined && QUOTA_STATUS_CODES.has(status);
}

export function isQuotaError(status: number | undefined, errorMessage: string | undefined): boolean {
	if (isQuotaStatus(status)) return true;
	return !!errorMessage && QUOTA_MESSAGE_PATTERNS.some((re) => re.test(errorMessage));
}

/**
 * Wraps `options.onResponse` to record the raw HTTP status of the call, preserving
 * any `onResponse` the caller already supplied.
 */
export function withStatusCapture<
	TOptions extends Record<string, unknown> & {
		onResponse?: (response: ProviderResponse, model: unknown) => void | Promise<void>;
	},
>(options: TOptions): { options: TOptions; getStatus: () => number | undefined } {
	let status: number | undefined;
	const priorOnResponse = options.onResponse;
	const options2: TOptions = {
		...options,
		onResponse: async (response: ProviderResponse, model: unknown) => {
			status = response.status;
			await priorOnResponse?.(response, model);
		},
	};
	return { options: options2, getStatus: () => status };
}

/**
 * Skips the current test when the captured status (or, failing that, the error
 * text) indicates a quota/rate-limit rejection rather than a genuine request bug.
 * No-op otherwise.
 */
export function skipIfQuotaExceeded(ctx: TestContext, status: number | undefined, errorMessage: string | undefined): void {
	ctx.skip(
		isQuotaError(status, errorMessage),
		`provider rate-limited/quota-exhausted (HTTP ${status ?? "unknown"}): ${errorMessage ?? "no error message"}`,
	);
}
