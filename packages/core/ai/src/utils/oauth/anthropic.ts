/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import { startCallbackServer } from "./callback-server.js";
import { parseAuthorizationInput } from "./parse-input.js";
import { generatePKCE } from "./pkce.js";
import { z } from "zod";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.js";

const TokenResponseSchema = z.object({
	access_token: z.string(),
	refresh_token: z.string(),
	expires_in: z.number(),
	scope: z.string().optional(),
});

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string env var should fall through to default
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

async function postJson(url: string, body: Record<string, string | number>): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});

	const responseBody = await response.text();

	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}

	return responseBody;
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
): Promise<OAuthCredentials> {
	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			state,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		});
	} catch (error) {
		throw new Error(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
		);
	}

	let tokenData: z.infer<typeof TokenResponseSchema>;
	try {
		tokenData = TokenResponseSchema.parse(JSON.parse(responseBody));
	} catch (error) {
		throw new Error(
			`Token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
	};
}

/**
 * Login with Anthropic OAuth (authorization code + PKCE)
 */
export async function loginAnthropic(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
}): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const server = await startCallbackServer({
		port: CALLBACK_PORT,
		path: CALLBACK_PATH,
		expectedState: verifier,
		successMessage: "Anthropic authentication completed. You can close this window.",
	});

	let code: string | undefined;
	let state: string | undefined;
	let redirectUriForExchange = server.redirectUri;

	try {
		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
		});

		options.onAuth({
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		if (options.onManualCodeInput) {
			let manualInput: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = options
				.onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch((err: unknown) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			const result = await server.waitForCode();

			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				code = result.code;
				state = result.state;
				redirectUriForExchange = REDIRECT_URI;
			} else if (manualInput) {
				const parsed = parseAuthorizationInput(manualInput);
				if (parsed.state && parsed.state !== verifier) {
					throw new Error("OAuth state mismatch");
				}
				code = parsed.code;
				state = parsed.state ?? verifier;
			}

			if (!code) {
				await manualPromise;
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- manualError may be set asynchronously by manualPromise
				if (manualError) {
					// eslint-disable-next-line @typescript-eslint/only-throw-error -- manualError set asynchronously, always Error
					throw manualError;
				}
				if (manualInput) {
					const parsed = parseAuthorizationInput(manualInput);
					if (parsed.state && parsed.state !== verifier) {
						throw new Error("OAuth state mismatch");
					}
					code = parsed.code;
					state = parsed.state ?? verifier;
				}
			}
		} else {
			const result = await server.waitForCode();
			if (result?.code) {
				code = result.code;
				state = result.state;
				redirectUriForExchange = REDIRECT_URI;
			}
		}

		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code or full redirect URL:",
				placeholder: REDIRECT_URI,
			});
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== verifier) {
				throw new Error("OAuth state mismatch");
			}
			code = parsed.code;
			state = parsed.state ?? verifier;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		if (!state) {
			throw new Error("Missing OAuth state");
		}

		options.onProgress?.("Exchanging authorization code for tokens...");
		return exchangeAuthorizationCode(code, state, verifier, redirectUriForExchange);
	} finally {
		server.close();
	}
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		});
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	let data: z.infer<typeof TokenResponseSchema>;
	try {
		data = TokenResponseSchema.parse(JSON.parse(responseBody));
	} catch (error) {
		throw new Error(
			`Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export const anthropicOAuthProvider: OAuthProviderInterface = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginAnthropic({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshAnthropicToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
