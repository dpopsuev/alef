import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeExtensionApi, NativeToolDefinition } from "../src/contracts.js";
import registerDiscourse from "../src/index.js";

interface RegisteredAdapter {
	readonly tools: Map<string, NativeToolDefinition>;
	renderContext(systemPrompt?: string): Promise<string | undefined>;
}

function registeredAdapter(): RegisteredAdapter {
	const tools = new Map<string, NativeToolDefinition>();
	let beforeAgentStart:
		| ((input: { readonly systemPrompt?: string }) => Promise<{ readonly systemPrompt: string } | undefined>)
		| undefined;
	const pi: NativeExtensionApi = {
		registerTool: (tool) => tools.set(tool.name, tool),
		on: (_event, handler) => {
			beforeAgentStart = handler;
		},
	};
	registerDiscourse(pi);
	return {
		tools,
		async renderContext(systemPrompt) {
			if (!beforeAgentStart) throw new Error("before_agent_start was not registered");
			return (await beforeAgentStart({ systemPrompt }))?.systemPrompt;
		},
	};
}

function requireTool(adapter: RegisteredAdapter, name: string): NativeToolDefinition {
	const tool = adapter.tools.get(name);
	if (!tool) throw new Error(`missing tool ${name}`);
	return tool;
}

afterEach(() => vi.restoreAllMocks());

describe("native Discourse adapter", () => {
	it("registers host-native post, read, and list tools", () => {
		const adapter = registeredAdapter();
		expect([...adapter.tools.keys()]).toEqual(["discourse_post", "discourse_read", "discourse_list"]);
	});

	it("maps native operations onto shared idempotent semantics", async () => {
		const adapter = registeredAdapter();
		const post = requireTool(adapter, "discourse_post");
		const read = requireTool(adapter, "discourse_read");
		const input = { topic: "reviews", thread: "nesting", content: "finding", author: "alice" };
		await post.execute("call-1", input);
		await post.execute("call-1", input);
		const output = await read.execute("read-1", { topic: "reviews", thread: "nesting" });
		const page = output.details?.page as { items?: readonly unknown[] } | undefined;
		expect(page?.items).toHaveLength(1);
		expect(output.content[0]?.text).toContain("finding");
	});

	it("injects committed posts through sequenced push delivery", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const adapter = registeredAdapter();
		await requireTool(adapter, "discourse_post").execute("call-1", {
			topic: "updates",
			thread: "status",
			content: "ready",
			author: "alice",
		});
		const prompt = await adapter.renderContext("base");
		expect(prompt).toContain("base");
		expect(prompt).toContain("[updates/status] @alice: ready");
		expect(await adapter.renderContext("base")).toBeUndefined();
	});

	it("rejects cross-thread replies before mutation", async () => {
		const adapter = registeredAdapter();
		const post = requireTool(adapter, "discourse_post");
		const root = await post.execute("root-call", { topic: "reviews", thread: "nesting", content: "root" });
		const posted = root.details?.posted as { post?: { id?: string } } | undefined;
		await expect(
			post.execute("reply-call", {
				topic: "reviews",
				thread: "naming",
				content: "reply",
				replyToPostId: posted?.post?.id,
			}),
		).rejects.toThrow("same thread");
	});
});
