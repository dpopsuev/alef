/**
 * OIDC Discovery — fetch provider configuration from .well-known/openid-configuration.
 *
 * Works with any RFC 8414 compliant issuer.
 * Results are cached per issuer URL for the process lifetime.
 */

/**
 *
 */
export interface OIDCConfig {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	userinfo_endpoint?: string;
	jwks_uri?: string;
	device_authorization_endpoint?: string;
	revocation_endpoint?: string;
	scopes_supported?: string[];
	grant_types_supported?: string[];
	response_types_supported?: string[];
}

const cache = new Map<string, OIDCConfig>();

/**
 *
 */
export async function discoverOIDC(issuerUrl: string): Promise<OIDCConfig> {
	const cached = cache.get(issuerUrl);
	if (cached) return cached;

	const wellKnown = issuerUrl.replace(/\/+$/, "") + "/.well-known/openid-configuration";
	const response = await fetch(wellKnown, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(10_000),
	});

	if (!response.ok) {
		throw new Error(`OIDC discovery failed: ${response.status} ${response.statusText} (${wellKnown})`);
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse result narrowed to OIDCConfig shape
	const config = (await response.json()) as OIDCConfig;

	if (!config.authorization_endpoint || !config.token_endpoint) {
		throw new Error(`OIDC config missing required endpoints (${wellKnown})`);
	}

	cache.set(issuerUrl, config);
	return config;
}

/**
 *
 */
export function clearOIDCCache(): void {
	cache.clear();
}

/**
 *
 */
export function supportsDeviceCode(config: OIDCConfig): boolean {
	return !!config.device_authorization_endpoint;
}

/**
 *
 */
export function supportsAuthorizationCode(config: OIDCConfig): boolean {
	const grants = config.grant_types_supported ?? [];
	return grants.length === 0 || grants.includes("authorization_code");
}
