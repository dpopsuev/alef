/** Thin bounded HTTP client for external artifact projection calls. */
import { z } from "zod";
import { SCRIBE_ERROR_DETAIL_MAX_CHARS, SCRIBE_REQUEST_TIMEOUT_MS, SCRIBE_RESPONSE_MAX_BYTES } from "./constants.js";
import type { ScribeArtifactCall } from "./scribe-projection.js";

const jsonRpcResult = z
	.object({
		jsonrpc: z.literal("2.0").optional(),
		id: z.union([z.string(), z.number()]).optional(),
		result: z
			.object({
				content: z
					.array(z.object({ type: z.string().optional(), text: z.string().optional() }).strict())
					.optional(),
				isError: z.boolean().optional(),
			})
			.strict()
			.optional(),
		error: z.object({ message: z.string().optional() }).strict().optional(),
	})
	.strict();
type JsonRpcResult = z.infer<typeof jsonRpcResult>;

/** Read a response without allowing an unbounded external payload. */
async function boundedResponseText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	let done = false;
	while (!done) {
		const chunk = await reader.read();
		if (chunk.done) {
			done = true;
			continue;
		}
		const value: unknown = chunk.value;
		if (!(value instanceof Uint8Array)) throw new Error("projection response contained an invalid byte chunk");
		bytes += value.byteLength;
		if (bytes > SCRIBE_RESPONSE_MAX_BYTES) {
			await reader.cancel();
			throw new Error(`projection response exceeds ${SCRIBE_RESPONSE_MAX_BYTES} bytes`);
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

/** Build one bounded artifact projection call against an HTTP endpoint. */
export function createHttpScribeArtifactCall(baseUrl: string, opts: { authToken?: string } = {}): ScribeArtifactCall {
	const endpoint = new URL(baseUrl);
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
		throw new Error("projection URL must use HTTP or HTTPS");
	let sessionId = "";
	let nextId = 1;
	let initPromise: Promise<void> | null = null;

	/** Post one bounded JSON-RPC request. */
	async function post(method: string, params: Record<string, unknown>): Promise<JsonRpcResult> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (sessionId) headers["Mcp-Session-Id"] = sessionId;
		const token = opts.authToken ?? process.env.SCRIBE_AUTH_TOKEN;
		if (token) headers.Authorization = `Bearer ${token}`;
		const response = await fetch(endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
			signal: AbortSignal.timeout(SCRIBE_REQUEST_TIMEOUT_MS),
		});
		const returnedSessionId = response.headers.get("Mcp-Session-Id");
		if (returnedSessionId) sessionId = returnedSessionId;
		const text = await boundedResponseText(response);
		if (!response.ok)
			throw new Error(`projection HTTP ${response.status}: ${text.slice(0, SCRIBE_ERROR_DETAIL_MAX_CHARS)}`);
		return jsonRpcResult.parse(JSON.parse(text));
	}

	/** Initialize the external protocol once. */
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
		const body = await post("tools/call", { name: "artifact", arguments: { action, ...params } });
		if (body.error?.message) throw new Error(body.error.message);
		if (body.result?.isError) {
			const text = body.result.content?.find((content) => content.type === "text")?.text ?? "projection error";
			throw new Error(text);
		}
		return body.result?.content?.find((content) => content.type === "text")?.text ?? "";
	};
}

/** Resolve optional endpoint configuration into a projection call. */
export function scribeCallFromEnv(): ScribeArtifactCall | undefined {
	const url = process.env.SCRIBE_URL?.trim();
	return url ? createHttpScribeArtifactCall(url) : undefined;
}
