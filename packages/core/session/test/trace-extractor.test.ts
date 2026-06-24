import { describe, expect, it } from "vitest";
import type { StorageRecord } from "../src/session-store.js";
import { extractTrace, traceToScript } from "../src/trace-extractor.js";

function rec(bus: StorageRecord["bus"], type: string, correlationId: string, payload: Record<string, unknown> = {}, timestamp = Date.now()): StorageRecord {
	return { bus, type, correlationId, payload, timestamp };
}

describe("extractTrace", { tags: ["unit"] }, () => {
	it("extracts a simple text-only turn", () => {
		const records: StorageRecord[] = [
			rec("event", "llm.input", "c-1", { text: "hello", sender: "human" }),
			rec("notification", "llm.result", "c-1", {
				response: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" },
				toolCalls: [],
				turn: 1,
			}),
			rec("command", "llm.response", "c-1", { text: "hi" }),
		];

		const trace = extractTrace(records);
		expect(trace).toHaveLength(1);
		expect(trace[0].userMessage).toBe("hello");
		expect(trace[0].finalReply).toBe("hi");
		expect(trace[0].toolExecutions).toHaveLength(0);
		expect(trace[0].llmResponse).toBeDefined();
	});

	it("extracts a turn with tool calls", () => {
		const records: StorageRecord[] = [
			rec("event", "llm.input", "c-1", { text: "read the file" }),
			rec("notification", "llm.result", "c-1", {
				response: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-1", name: "fs.read", arguments: { path: "/tmp/f.txt" } }],
					stopReason: "toolUse",
				},
				toolCalls: [{ name: "fs.read", args: { path: "/tmp/f.txt" }, id: "tc-1" }],
				turn: 1,
			}),
			rec("command", "fs.read", "c-1", { path: "/tmp/f.txt", toolCallId: "tc-1" }),
			rec("event", "fs.read", "c-1", { content: [{ type: "text", text: "file content" }], toolCallId: "tc-1" }),
			rec("notification", "llm.result", "c-1", {
				response: {
					role: "assistant",
					content: [{ type: "text", text: "The file contains: file content" }],
					stopReason: "stop",
				},
				toolCalls: [],
				turn: 1,
			}),
			rec("command", "llm.response", "c-1", { text: "The file contains: file content" }),
		];

		const trace = extractTrace(records);
		expect(trace).toHaveLength(1);
		expect(trace[0].toolExecutions).toHaveLength(1);
		expect(trace[0].toolExecutions[0].toolName).toBe("fs.read");
		expect(trace[0].toolExecutions[0].callId).toBe("tc-1");
		expect(trace[0].toolExecutions[0].args.path).toBe("/tmp/f.txt");
		expect(trace[0].toolExecutions[0].result.content).toBeDefined();
		expect(trace[0].finalReply).toBe("The file contains: file content");
	});

	it("extracts multiple turns in order", () => {
		const records: StorageRecord[] = [
			rec("event", "llm.input", "c-1", { text: "first" }),
			rec("command", "llm.response", "c-1", { text: "r1" }),
			rec("event", "llm.input", "c-2", { text: "second" }),
			rec("command", "llm.response", "c-2", { text: "r2" }),
			rec("event", "llm.input", "c-3", { text: "third" }),
			rec("command", "llm.response", "c-3", { text: "r3" }),
		];

		const trace = extractTrace(records);
		expect(trace).toHaveLength(3);
		expect(trace.map((s) => s.userMessage)).toEqual(["first", "second", "third"]);
		expect(trace.map((s) => s.turn)).toEqual([0, 1, 2]);
	});

	it("pairs multiple tool calls by toolCallId", () => {
		const records: StorageRecord[] = [
			rec("event", "llm.input", "c-1", { text: "do two things" }),
			rec("notification", "llm.result", "c-1", {
				response: { role: "assistant", content: [], stopReason: "toolUse" },
				toolCalls: [
					{ name: "fs.read", args: { path: "a.ts" }, id: "tc-a" },
					{ name: "fs.read", args: { path: "b.ts" }, id: "tc-b" },
				],
				turn: 1,
			}),
			rec("command", "fs.read", "c-1", { path: "a.ts", toolCallId: "tc-a" }),
			rec("command", "fs.read", "c-1", { path: "b.ts", toolCallId: "tc-b" }),
			rec("event", "fs.read", "c-1", { content: "aaa", toolCallId: "tc-a" }),
			rec("event", "fs.read", "c-1", { content: "bbb", toolCallId: "tc-b" }),
			rec("command", "llm.response", "c-1", { text: "done" }),
		];

		const trace = extractTrace(records);
		expect(trace[0].toolExecutions).toHaveLength(2);
		const byId = new Map(trace[0].toolExecutions.map((e) => [e.callId, e]));
		expect(byId.get("tc-a")!.result.content).toBe("aaa");
		expect(byId.get("tc-b")!.result.content).toBe("bbb");
	});

	it("handles old bus naming (motor/sense)", () => {
		const records: StorageRecord[] = [
			rec("sense" as StorageRecord["bus"], "llm.input", "c-1", { text: "hello" }),
			rec("sense" as StorageRecord["bus"], "llm.result", "c-1", {
				response: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" },
				toolCalls: [],
				turn: 1,
			}),
			rec("motor" as StorageRecord["bus"], "llm.response", "c-1", { text: "hi" }),
		];

		const trace = extractTrace(records);
		expect(trace).toHaveLength(1);
		expect(trace[0].finalReply).toBe("hi");
	});
});

describe("traceToScript", { tags: ["unit"] }, () => {
	it("generates readable script from trace", () => {
		const records: StorageRecord[] = [
			rec("event", "llm.input", "c-1", { text: "read file" }),
			rec("command", "fs.read", "c-1", { path: "/tmp/f.txt", toolCallId: "tc-1" }),
			rec("event", "fs.read", "c-1", { content: "data", toolCallId: "tc-1" }),
			rec("command", "llm.response", "c-1", { text: "found it" }),
		];

		const trace = extractTrace(records);
		const script = traceToScript(trace);
		expect(script).toContain('await tools.call("fs.read"');
		expect(script).toContain("Turn 0");
		expect(script).toContain("found it");
	});
});
