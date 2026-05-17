/**
 * Payload redaction for the audit event log.
 *
 * Deep-scans event payload objects and replaces the values of sensitive keys
 * with "[REDACTED]" before writing to the JSONL log. Prevents credentials,
 * tokens, and secrets from landing on disk.
 *
 * Sensitive key detection: case-insensitive substring match against a
 * configurable allow-list. Nested objects and arrays are scanned recursively.
 *
 * What is NOT redacted:
 *   - Values of non-sensitive keys (content, output, text, command, etc.)
 *   - Embedded secrets inside string values (e.g. bearer tokens in curl commands)
 *     — Phase 2: add regex scanning of string values
 *
 * Configuration:
 *   ALEF_AUDIT_SENSITIVE_KEYS=comma,separated,keys   (appends to defaults)
 *   ALEF_AUDIT_REDACT_DISABLED=1                      (disable redaction)
 *
 * Ref: ALE-TSK-137
 */

export const REDACTED = "[REDACTED]";

/** Default sensitive key name substrings (case-insensitive). */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
	"password",
	"passwd",
	"secret",
	"token", // matches token, apiToken, authToken, accessToken, bearerToken, sessionToken
	"apikey",
	"api_key",
	"credential",
	"privatekey",
	"private_key",
	"clientsecret",
	"client_secret",
	"authorization",
	"cookie",
	"sessionkey",
	"session_key",
	"x-api-key",
];

function buildSensitiveSet(): Set<string> {
	const keys = new Set(DEFAULT_SENSITIVE_KEYS);
	const extra = process.env.ALEF_AUDIT_SENSITIVE_KEYS;
	if (extra) {
		for (const k of extra.split(",").map((s) => s.trim().toLowerCase())) {
			if (k) keys.add(k);
		}
	}
	return keys;
}

// Build once at module load — keys are environment-configured.
const sensitiveKeys = buildSensitiveSet();

function isSensitiveKey(key: string): boolean {
	const lower = key.toLowerCase();
	for (const sensitive of sensitiveKeys) {
		if (lower.includes(sensitive)) return true;
	}
	return false;
}

/**
 * Deep-scan a payload object and replace sensitive key values with REDACTED.
 * Returns a new object — the original is not mutated.
 * Arrays are scanned element-by-element.
 * Non-object values are returned unchanged.
 */
export function redactPayload(value: unknown, depth = 0): unknown {
	// Guard against infinite recursion on circular structures.
	if (depth > 10) return value;
	if (process.env.ALEF_AUDIT_REDACT_DISABLED === "1") return value;

	if (Array.isArray(value)) {
		return value.map((item) => redactPayload(item, depth + 1));
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			result[key] = isSensitiveKey(key) ? REDACTED : redactPayload(val, depth + 1);
		}
		return result;
	}

	return value;
}
