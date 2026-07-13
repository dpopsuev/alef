/**
 * Payload redaction for the audit event log.
 *
 * Replaces producer-marked Sensitive() values with "[REDACTED]" before
 * writing to the session store. Producers own classification — wrap secrets
 * at the publish site (see @dpopsuev/alef-kernel/sensitive). The sink does
 * not guess from key names.
 *
 * Configuration:
 *   ALEF_AUDIT_REDACT_DISABLED=1  — disable redaction (debug only)
 */

import type { Bus, BusMiddleware } from "@dpopsuev/alef-kernel/bus";
import {
	isSensitive,
	REDACTED,
	reveal,
	Sensitive,
	type SensitiveValue,
} from "@dpopsuev/alef-kernel/sensitive";

export { isSensitive, REDACTED, reveal, Sensitive, type SensitiveValue };

const MAX_REDACTION_DEPTH = 10;

/**
 * Deep-scan a payload and replace Sensitive markers with REDACTED.
 * Returns a new object — the original is not mutated.
 */
export function redactPayload(value: unknown, depth = 0): unknown {
	if (depth > MAX_REDACTION_DEPTH) return value;
	if (process.env.ALEF_AUDIT_REDACT_DISABLED === "1") {
		return isSensitive(value) ? reveal(value) : value;
	}
	if (isSensitive(value)) return REDACTED;

	if (Array.isArray(value)) {
		return value.map((item) => redactPayload(item, depth + 1));
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- guarded by typeof object && !== null check
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			result[key] = redactPayload(val, depth + 1);
		}
		return result;
	}

	return value;
}

/** Apply payload redaction to all SenseEvents before they reach the subscriber. */
export const withEventBusRedaction: BusMiddleware = (baseBus: Bus): Bus => ({
	...baseBus,
	event: {
		subscribe: (type, handler) =>
			baseBus.event.subscribe(type, (event) =>
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- redactPayload preserves Record shape
				handler({ ...event, payload: redactPayload(event.payload) as Record<string, unknown> }),
			),
		publish: baseBus.event.publish.bind(baseBus.event),
	},
});
