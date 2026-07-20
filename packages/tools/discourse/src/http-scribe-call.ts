/**
 * Thin Streamable-HTTP MCP client for Scribe artifact calls (SCRIBE_URL).
 */
import type { ScribeArtifactCall } from "./scribe-projection.js";

type JsonRpcResult = {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: { message?: string };
};

/**
 * Build a ScribeArtifactCall against a Streamable HTTP MCP endpoint.
 * Session is established on first use (initialize + tools/call).
 */
export function createHttpScribeArtifactCall(baseUrl: string, opts: { authToken?: string } = {}): ScribeArtifactCall {
	let sessionId = "";
	let nextId = 1;
	let initPromise: Promise<void> | null = null;

	/**
	 * Post JSON-RPC to the Streamable HTTP MCP endpoint.
	 */
	async function post(method: string, params: Record<string, unknown>): Promise<JsonRpcResult> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (sessionId) headers["Mcp-Session-Id"] = sessionId;
		const token = opts.authToken ?? process.env.SCRIBE_AUTH_TOKEN;
		if (token) headers.Authorization = `Bearer ${token}`;

		const response = await fetch(baseUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
		});
		const sid = response.headers.get("Mcp-Session-Id");
		if (sid) sessionId = sid;
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Scribe MCP HTTP ${response.status}: ${body.slice(0, 200)}`);
		}
		const raw: unknown = await response.json();
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- MCP JSON-RPC envelope
		return raw as JsonRpcResult;
	}

	/** Lazy-initialize MCP session once. */
	function ensureInit(): Promise<void> {
		initPromise ??= post("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "alef-discourse", version: "0.1" },
		}).then(() => undefined);
		return initPromise;
	}

	return async (action, params) => {
		await ensureInit();
		const body = await post("tools/call", {
			name: "artifact",
			arguments: { action, ...params },
		});
		if (body.error?.message) throw new Error(body.error.message);
		if (body.result?.isError) {
			const text = body.result.content?.find((c) => c.type === "text")?.text ?? "scribe error";
			throw new Error(text);
		}
		const text = body.result?.content?.find((c) => c.type === "text")?.text;
		return text ?? "";
	};
}

/** Resolve SCRIBE_URL (+ optional SCRIBE_AUTH_TOKEN) into a call, or undefined. */
export function scribeCallFromEnv(): ScribeArtifactCall | undefined {
	const url = process.env.SCRIBE_URL?.trim();
	if (!url) return undefined;
	return createHttpScribeArtifactCall(url);
}
