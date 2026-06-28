/**
 * Parse an authorization response — redirect URL, query string, or raw code.
 *
 * Handles all common paste formats:
 *   - Full URL: http://localhost:8160/callback?code=abc&state=xyz
 *   - Hash-separated: abc#xyz
 *   - Query string: code=abc&state=xyz
 *   - Raw code: abc
 */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}
