import { describe, expect, it } from "vitest";
import {
	projectSessionRecords,
	projectTranscriptSlice,
	selectRecentTranscriptRecords,
	selectTranscriptBlocks,
	type SessionRecordProjection,
} from "../src/context/projector.js";

function rec(bus: string, type: string, payload: Record<string, unknown> = {}): SessionRecordProjection {
	return { bus, type, payload };
}

describe("projectSessionRecords", { tags: ["unit"] }, () => {
	it("projects user, assistant, and tool blocks in chronological order", () => {
		const records = [
			rec("event", "llm.input", { text: "first question" }),
			rec("command", "llm.response", { text: "first answer" }),
			rec("command", "fs.read", { path: "/tmp/f.txt" }),
			rec("event", "llm.input", { text: "second question" }),
		];

		const blocks = projectSessionRecords(records);

		expect(blocks).toEqual([
			{ kind: "user", text: "first question" },
			{ kind: "assistant", text: "first answer" },
			{ kind: "tool", name: "fs.read", summary: "/tmp/f.txt" },
			{ kind: "user", text: "second question" },
		]);
	});

	it("skips noise event types", () => {
		const records = [
			rec("event", "adapter.loaded", { name: "fs" }),
			rec("event", "llm.chunk", { text: "partial" }),
			rec("event", "llm.checkpoint", {}),
			rec("event", "llm.thinking", { text: "hmm" }),
			rec("event", "context.assemble", {}),
			rec("event", "llm.tool-chunk", { text: "tool partial" }),
			rec("event", "llm.token-usage", { usage: { input: 1 } }),
			rec("event", "llm.input", { text: "visible" }),
		];

		const blocks = projectSessionRecords(records);

		expect(blocks).toEqual([{ kind: "user", text: "visible" }]);
	});

	it("includes a plan block when options.plan is provided", () => {
		const blocks = projectSessionRecords([rec("event", "llm.input", { text: "go" })], {
			plan: {
				phase: "implement",
				desired: "add projector",
				current: "writing tests",
				stepSummary: "2/5 done, next: export",
			},
		});

		expect(blocks[0]).toEqual({
			kind: "plan",
			phase: "implement",
			desired: "add projector",
			lines: ["writing tests", "2/5 done, next: export"],
		});
		expect(blocks[1]).toEqual({ kind: "user", text: "go" });
	});

	it("collapses whitespace in projected text", () => {
		const blocks = projectSessionRecords([rec("event", "llm.input", { text: "  hello \n  world  " })]);

		expect(blocks[0]).toEqual({ kind: "user", text: "hello world" });
	});

	it("projects context.injection as state/context", () => {
		const blocks = projectSessionRecords([
			rec("notification", "context.injection", {
				source: "plan",
				chars: 42,
				preview: "Plan: ship projector",
			}),
		]);
		expect(blocks).toEqual([
			{ kind: "state", label: "context", text: "plan (+42) Plan: ship projector" },
		]);
	});
});

describe("selectTranscriptBlocks", { tags: ["unit"] }, () => {
	it("keeps plan blocks and the last maxTurns user turns with tools", () => {
		const blocks = projectSessionRecords(
			[
				rec("event", "llm.input", { text: "old" }),
				rec("command", "fs.read", { path: "/old" }),
				rec("event", "llm.input", { text: "mid" }),
				rec("command", "llm.response", { text: "mid reply" }),
				rec("event", "llm.input", { text: "new" }),
				rec("command", "fs.edit", { path: "/new" }),
			],
			{
				plan: { phase: "ship", desired: "preview", current: "wiring" },
			},
		);

		expect(selectTranscriptBlocks(blocks, 2)).toEqual([
			{ kind: "plan", phase: "ship", desired: "preview", lines: ["wiring"] },
			{ kind: "user", text: "mid" },
			{ kind: "assistant", text: "mid reply" },
			{ kind: "user", text: "new" },
			{ kind: "tool", name: "fs.edit", summary: "/new" },
		]);
	});
});

describe("selectRecentTranscriptRecords", { tags: ["unit"] }, () => {
	it("skips post-dialog boot noise that would empty a naive slice(-N)", () => {
		const dialog = [
			rec("event", "llm.input", { text: "hello" }),
			rec("command", "llm.response", { text: "hi" }),
			rec("event", "llm.input", { text: "spawn agent" }),
			rec("command", "llm.response", { text: "spawned" }),
		];
		const bootNoise = Array.from({ length: 80 }, (_, i) =>
			i % 2 === 0 ? rec("event", "adapter.loaded", { name: `a${i}` }) : rec("event", "agent.run", { text: "x" }),
		);
		const selected = selectRecentTranscriptRecords([...dialog, ...bootNoise], 5);
		expect(selected).toEqual(dialog);
	});

	it("stops after maxTurns user inputs while keeping tools between them", () => {
		const selected = selectRecentTranscriptRecords(
			[
				rec("event", "llm.input", { text: "old" }),
				rec("command", "fs.read", { path: "/old" }),
				rec("command", "llm.response", { text: "old reply" }),
				rec("event", "llm.input", { text: "new" }),
				rec("command", "fs.edit", { path: "/new" }),
				rec("command", "llm.response", { text: "new reply" }),
				rec("event", "adapter.loaded", { name: "fs" }),
			],
			1,
		);
		expect(selected).toEqual([
			rec("event", "llm.input", { text: "new" }),
			rec("command", "fs.edit", { path: "/new" }),
			rec("command", "llm.response", { text: "new reply" }),
		]);
	});
});

describe("projectTranscriptSlice", { tags: ["unit"] }, () => {
	it("is the shared select→project→trim path for preview and resume", () => {
		const bootNoise = Array.from({ length: 40 }, () => rec("event", "adapter.loaded", { name: "fs" }));
		const blocks = projectTranscriptSlice(
			[
				rec("event", "llm.input", { text: "old" }),
				rec("command", "llm.response", { text: "old reply" }),
				rec("event", "llm.input", { text: "new" }),
				rec("command", "fs.read", { path: "/x" }),
				rec("command", "llm.response", { text: "new reply" }),
				...bootNoise,
			],
			1,
			{ plan: { phase: "ship", desired: "dry preview" } },
		);

		expect(blocks).toEqual([
			{ kind: "plan", phase: "ship", desired: "dry preview", lines: [] },
			{ kind: "user", text: "new" },
			{ kind: "tool", name: "fs.read", summary: "/x" },
			{ kind: "assistant", text: "new reply" },
		]);
	});
});
