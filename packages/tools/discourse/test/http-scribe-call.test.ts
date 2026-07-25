import { afterEach, describe, expect, it, vi } from "vitest";
import { SCRIBE_RESPONSE_MAX_BYTES } from "../src/constants.js";
import { createHttpScribeArtifactCall, scribeCallFromEnv } from "../src/http-scribe-call.js";

describe("createHttpScribeArtifactCall", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.SCRIBE_URL;
	});

	it("initializes session then tools/call artifact", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { method: string; params: { arguments?: { action: string } } };
			const headers = new Headers();
			if (body.method === "initialize") headers.set("Mcp-Session-Id", "sess-1");
			if (body.method === "tools/call") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 2,
						result: { content: [{ type: "text", text: "ok-create" }] },
					}),
					{ status: 200, headers },
				);
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
				status: 200,
				headers,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const call = createHttpScribeArtifactCall("http://scribe.test/");
		const text = await call("create", { id: "ctx-1", title: "t" });
		expect(text).toBe("ok-create");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
		expect((second.headers as Record<string, string>)["Mcp-Session-Id"]).toBe("sess-1");
		const payload = JSON.parse(String(second.body)) as {
			method: string;
			params: { name: string; arguments: { action: string; id: string } };
		};
		expect(payload.method).toBe("tools/call");
		expect(payload.params).toMatchObject({
			name: "artifact",
			arguments: { action: "create", id: "ctx-1", title: "t" },
		});
	});

	it("bounds external responses and configures a request deadline", async () => {
		const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return new Response("x".repeat(SCRIBE_RESPONSE_MAX_BYTES + 1), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const call = createHttpScribeArtifactCall("http://scribe.test/");
		await expect(call("create", {})).rejects.toThrow("response exceeds");
	});

	it("scribeCallFromEnv returns undefined without SCRIBE_URL", () => {
		expect(scribeCallFromEnv()).toBeUndefined();
	});

	it("scribeCallFromEnv builds call when SCRIBE_URL set", () => {
		process.env.SCRIBE_URL = "http://localhost:8080/";
		expect(scribeCallFromEnv()).toBeTypeOf("function");
	});
});
