/**
 * Reusable localhost OAuth callback server.
 *
 * Spins up a temporary HTTP server on 127.0.0.1 to receive the
 * authorization code redirect from the identity provider.
 *
 * NOTE: Node.js only — lazy-loads node:http to avoid breaking browser builds.
 */

import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";

/**
 *
 */
export interface CallbackServerConfig {
	port: number;
	path: string;
	host?: string;
	expectedState?: string;
	successMessage?: string;
}

/**
 *
 */
export interface CallbackServerHandle {
	close(): void;
	cancelWait(): void;
	waitForCode(): Promise<{ code: string; state?: string } | null>;
	redirectUri: string;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline import() needed: @types/node not in tsconfig
let _createServer: typeof import("node:http").createServer | null = null;

 
/**
 *
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
async function ensureHttp(): Promise<typeof import("node:http").createServer> {
	if (_createServer) return _createServer;
	const http = await import("node:http");
	_createServer = http.createServer;
	return _createServer;
}

/**
 *
 */
export async function startCallbackServer(config: CallbackServerConfig): Promise<CallbackServerHandle> {
	const createServer = await ensureHttp();
	const host = config.host ?? process.env.ALEF_OAUTH_CALLBACK_HOST ?? "127.0.0.1";
	const redirectUri = `http://localhost:${config.port}${config.path}`;

	let settleWait: ((value: { code: string; state?: string } | null) => void) | undefined;
	const waitForCodePromise = new Promise<{ code: string; state?: string } | null>((resolve) => {
		let settled = false;
		settleWait = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});

	const server = createServer((req, res) => {
		try {
			const url = new URL(req.url ?? "", "http://localhost");
			if (url.pathname !== config.path) {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}

			const error = url.searchParams.get("error");
			if (error) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Authentication did not complete.", `Error: ${error}`));
				return;
			}

			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state") ?? undefined;

			if (!code) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Missing authorization code."));
				return;
			}

			if (config.expectedState && state !== config.expectedState) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("State mismatch."));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(oauthSuccessHtml(config.successMessage ?? "Authentication completed. You can close this window."));
			settleWait?.({ code, state });
		} catch {
			res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Internal error");
		}
	});

	return new Promise((resolve, reject) => {
		server.on("error", (err) => {
			settleWait?.(null);
			reject(err);
		});

		server.listen(config.port, host, () => {
			resolve({
				redirectUri,
				close: () => server.close(),
				cancelWait: () => settleWait?.(null),
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}
