import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { describe, expect, it } from "vitest";
import type { SessionTrace, TraceStep } from "../src/tracing/extractor.js";
import { TraceReasonerAdapter, TraceToolAdapter, createReplayAdapters } from "../src/tracing/replayer.js";

function step(overrides: Partial<TraceStep> = {}): TraceStep {
	return {
		turn: 0,
		correlationId: "c-1",
		userMessage: "hello",
		llmResponse: undefined,
		toolExecutions: [],
		finalReply: "hi there",
		...overrides,
	};
}

describe("TraceReasonerAdapter", { tags: ["unit"] }, () => {
	it("replays a text-only turn", async () => {
		const trace: SessionTrace = [step({ finalReply: "replayed response" })];
		const adapter = new TraceReasonerAdapter(trace);
		const ipBus = new InProcessBus();
		const bus = ipBus.asBus();
		adapter.mount(bus);

		const replyPromise = new Promise<string>((resolve) => {
			bus.command.subscribe("llm.response", (e) => {
				resolve(typeof (e as { payload?: { text?: string } }).payload?.text === "string"
					? (e as unknown as { payload: { text: string } }).payload.text
					: "");
			});
		});

		bus.event.publish({
			type: "llm.input",
			correlationId: "c-1",
			payload: { text: "hello", sender: "human" },
			isError: false,
		});

		const reply = await replyPromise;
		expect(reply).toBe("replayed response");
	});

	it("replays a turn with tool calls", async () => {
		const trace: SessionTrace = [step({
			toolExecutions: [{
				callId: "tc-1",
				toolName: "fs.read",
				args: { path: "/tmp/f.txt" },
				result: { content: [{ type: "text", text: "file data" }], toolCallId: "tc-1" },
				elapsed: 10,
			}],
			finalReply: "found it",
		})];

		const { reasoner, tools } = createReplayAdapters(trace);
		const ipBus = new InProcessBus();
		const bus = ipBus.asBus();
		reasoner.mount(bus);
		tools.mount(bus);

		const toolStarts: string[] = [];
		bus.notification.subscribe("llm.tool-start", (e) => {
			toolStarts.push(String((e as { payload?: { name?: string } }).payload?.name));
		});

		const replyPromise = new Promise<string>((resolve) => {
			bus.command.subscribe("llm.response", (e) => {
				resolve(String((e as { payload?: { text?: string } }).payload?.text ?? ""));
			});
		});

		bus.event.publish({
			type: "llm.input",
			correlationId: "c-1",
			payload: { text: "read file" },
			isError: false,
		});

		const reply = await replyPromise;
		expect(reply).toBe("found it");
		expect(toolStarts).toContain("fs.read");
	});

	it("reports zero token usage", async () => {
		const trace: SessionTrace = [step()];
		const adapter = new TraceReasonerAdapter(trace);
		const ipBus = new InProcessBus();
		const bus = ipBus.asBus();
		adapter.mount(bus);

		const usagePromise = new Promise<Record<string, unknown>>((resolve) => {
			bus.notification.subscribe("llm.token-usage", (e) => {
				resolve((e as { payload?: Record<string, unknown> }).payload ?? {});
			});
		});

		bus.event.publish({
			type: "llm.input",
			correlationId: "c-1",
			payload: { text: "hello" },
			isError: false,
		});

		const usage = await usagePromise;
		const u = usage.usage as { input: number; output: number; totalTokens: number };
		expect(u.input).toBe(0);
		expect(u.output).toBe(0);
		expect(u.totalTokens).toBe(0);
	});
});

describe("TraceToolAdapter", { tags: ["unit"] }, () => {
	it("returns recorded result for tool command", async () => {
		const trace: SessionTrace = [step({
			toolExecutions: [{
				callId: "tc-1",
				toolName: "fs.read",
				args: { path: "/tmp/f.txt" },
				result: { content: "recorded content", toolCallId: "tc-1" },
				elapsed: 5,
			}],
		})];

		const adapter = new TraceToolAdapter(trace);
		const ipBus = new InProcessBus();
		const bus = ipBus.asBus();
		adapter.mount(bus);

		const resultPromise = new Promise<Record<string, unknown>>((resolve) => {
			bus.event.subscribe("fs.read", (e) => {
				resolve((e as { payload?: Record<string, unknown> }).payload ?? {});
			});
		});

		bus.command.publish({
			type: "fs.read",
			correlationId: "c-1",
			payload: { path: "/tmp/f.txt", toolCallId: "tc-1" },
		});

		const result = await resultPromise;
		expect(result.content).toBe("recorded content");
	});
});
