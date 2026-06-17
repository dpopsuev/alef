import { InProcessNerve } from "@dpopsuev/alef-kernel";
import { describe, expect, it } from "vitest";
import { createCompactorOrgan } from "../src/organ.js";

function makeMessage(role: string, text: string): Record<string, unknown> {
	return { role, content: text, timestamp: Date.now() };
}

function longText(chars: number): string {
	return "x".repeat(chars);
}

describe("compactor behavior", { tags: ["unit"] }, () => {
	it("does not compact when below threshold", async () => {
		const organ = createCompactorOrgan({
			cwd: "/tmp",
			contextWindow: 1000,
			threshold: 0.7,
			preserveRecentTurns: 2,
		});

		const handler = organ.contributions?.["context.assemble"];
		expect(handler).toBeDefined();

		const messages = [makeMessage("user", "hello"), makeMessage("assistant", "hi")];

		const result = await handler!({ messages, turn: 1, tools: [] });
		expect(result.messages).toBeUndefined();
	});

	it("compacts when above threshold", async () => {
		const organ = createCompactorOrgan({
			cwd: "/tmp",
			contextWindow: 100,
			threshold: 0.5,
			preserveRecentTurns: 2,
		});

		const handler = organ.contributions?.["context.assemble"];

		const messages = [
			makeMessage("system", "You are a helpful assistant."),
			makeMessage("user", longText(200)),
			makeMessage("assistant", longText(200)),
			makeMessage("user", longText(200)),
			makeMessage("assistant", longText(200)),
			makeMessage("user", "recent question"),
			makeMessage("assistant", "recent answer"),
		];

		const result = await handler!({ messages, turn: 5, tools: [] });
		expect(result.messages).toBeDefined();
		const compacted = result.messages!;

		expect((compacted[0] as { role: string }).role).toBe("system");

		const summary = compacted[1] as { role: string; content: string };
		expect(summary.role).toBe("user");
		expect(summary.content).toContain("[Context compacted");

		const recent = compacted.slice(-2);
		expect((recent[0] as { content: string }).content).toBe("recent question");
		expect((recent[1] as { content: string }).content).toBe("recent answer");
	});

	it("preserves system message through compaction", async () => {
		const organ = createCompactorOrgan({
			cwd: "/tmp",
			contextWindow: 50,
			threshold: 0.3,
			preserveRecentTurns: 1,
		});

		const handler = organ.contributions?.["context.assemble"];
		const systemPrompt = "System instructions here";

		const messages = [
			makeMessage("system", systemPrompt),
			makeMessage("user", longText(300)),
			makeMessage("assistant", longText(300)),
			makeMessage("user", "latest"),
		];

		const result = await handler!({ messages, turn: 3, tools: [] });
		expect(result.messages).toBeDefined();

		const first = result.messages![0] as { role: string; content: string };
		expect(first.role).toBe("system");
		expect(first.content).toBe(systemPrompt);
	});

	it("does not compact when not enough messages to preserve", async () => {
		const organ = createCompactorOrgan({
			cwd: "/tmp",
			contextWindow: 10,
			threshold: 0.1,
			preserveRecentTurns: 4,
		});

		const handler = organ.contributions?.["context.assemble"];

		const messages = [
			makeMessage("user", longText(200)),
			makeMessage("assistant", longText(200)),
			makeMessage("user", longText(200)),
		];

		const result = await handler!({ messages, turn: 2, tools: [] });
		expect(result.messages).toBeUndefined();
	});

	it("compaction history records entries", async () => {
		const organ = createCompactorOrgan({
			cwd: "/tmp",
			contextWindow: 100,
			threshold: 0.5,
			preserveRecentTurns: 2,
		});

		const handler = organ.contributions?.["context.assemble"];
		const messages = [
			makeMessage("system", "System prompt"),
			makeMessage("user", longText(200)),
			makeMessage("assistant", longText(200)),
			makeMessage("user", longText(200)),
			makeMessage("assistant", longText(200)),
			makeMessage("user", "recent"),
			makeMessage("assistant", "recent"),
		];

		await handler!({ messages, turn: 5, tools: [] });
		await handler!({ messages, turn: 6, tools: [] });

		const nerve = new (await import("@dpopsuev/alef-kernel")).InProcessNerve();
		const off = organ.mount(nerve.asNerve());

		const stats = await new Promise<{ payload: Record<string, unknown> }>((resolve) => {
			const correlationId = "test-history";
			nerve.asNerve().sense.subscribe("compactor.stats", (event) => {
				if (event.correlationId === correlationId) resolve(event);
			});
			nerve.asNerve().motor.publish({ type: "compactor.stats", correlationId, payload: {} });
		});

		expect(stats.payload.compactionCount).toBe(2);
		expect(stats.payload.historyLength).toBe(2);
		off();
	});

	it("prior summary injected when below threshold after compaction", async () => {
		const organ = createCompactorOrgan({
			cwd: "/tmp",
			contextWindow: 100,
			threshold: 0.5,
			preserveRecentTurns: 2,
		});

		const handler = organ.contributions?.["context.assemble"];

		const bigMessages = [
			makeMessage("system", "System"),
			makeMessage("user", longText(200)),
			makeMessage("assistant", longText(200)),
			makeMessage("user", longText(200)),
			makeMessage("assistant", longText(200)),
			makeMessage("user", "recent"),
			makeMessage("assistant", "recent"),
		];
		await handler!({ messages: bigMessages, turn: 5, tools: [] });

		const smallMessages = [
			makeMessage("system", "System"),
			makeMessage("user", "short question"),
			makeMessage("assistant", "short answer"),
		];
		const result = await handler!({ messages: smallMessages, turn: 6, tools: [] });

		expect(result.messages).toBeDefined();
		const contents = result.messages!.map((m) => (m as { content: string }).content);
		const hasSummary = contents.some((c) => typeof c === "string" && c.includes("[Context compacted"));
		expect(hasSummary).toBe(true);
	});

	it("custom summarize function replaces default", async () => {
		const organ = createCompactorOrgan({
			cwd: "/tmp",
			contextWindow: 100,
			threshold: 0.5,
			preserveRecentTurns: 2,
			summarize: async () => "[LLM Summary] Goal: test. Progress: done.",
		});

		const handler = organ.contributions?.["context.assemble"];
		const messages = [
			makeMessage("system", "System"),
			makeMessage("user", longText(200)),
			makeMessage("assistant", longText(200)),
			makeMessage("user", longText(200)),
			makeMessage("assistant", longText(200)),
			makeMessage("user", "recent"),
			makeMessage("assistant", "recent"),
		];

		const result = await handler!({ messages, turn: 5, tools: [] });
		expect(result.messages).toBeDefined();
		const contents = result.messages!.map((m) => (m as { content: string }).content);
		const hasLLM = contents.some((c) => typeof c === "string" && c.includes("[LLM Summary]"));
		expect(hasLLM).toBe(true);
	});

	it("compactor.stats reports metrics via motor/sense", async () => {
		const nerve = new InProcessNerve();
		const organ = createCompactorOrgan({ cwd: "/tmp", contextWindow: 5000 });
		const off = organ.mount(nerve.asNerve());

		const result = await new Promise<{ payload: Record<string, unknown> }>((resolve) => {
			const correlationId = "test-stats";
			nerve.asNerve().sense.subscribe("compactor.stats", (event) => {
				if (event.correlationId === correlationId) resolve(event);
			});
			nerve.asNerve().motor.publish({
				type: "compactor.stats",
				correlationId,
				payload: {},
			});
		});

		expect(result.payload.contextWindow).toBe(5000);
		expect(result.payload.compactionCount).toBe(0);
		off();
	});
});
