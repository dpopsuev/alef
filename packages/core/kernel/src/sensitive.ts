/**
 * Producer-side sensitive value marker.
 *
 * Wrap secrets at the publish site. Audit sinks replace markers with
 * "[REDACTED]"; in-process consumers call reveal() to read the value.
 * Key-name grepping at the sink is intentionally not used.
 */

const SENSITIVE_TAG = Symbol.for("alef.sensitive");

export const REDACTED = "[REDACTED]";

/** Branded wrapper produced by Sensitive(). */
export interface SensitiveValue<T = unknown> {
	readonly [SENSITIVE_TAG]: true;
	readonly value: T;
	toJSON(): typeof REDACTED;
}

/** Mark a value as secret for audit sinks. Does not encrypt. */
export function Sensitive<T>(value: T): SensitiveValue<T> {
	return {
		[SENSITIVE_TAG]: true,
		value,
		toJSON: () => REDACTED,
	};
}

/** True when value was produced by Sensitive(). */
export function isSensitive(value: unknown): value is SensitiveValue {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [SENSITIVE_TAG]?: unknown })[SENSITIVE_TAG] === true &&
		"value" in value
	);
}

/** Unwrap a Sensitive marker; pass through non-markers unchanged. */
export function reveal<T>(value: T | SensitiveValue<T>): T {
	if (isSensitive(value)) return value.value;
	return value;
}
