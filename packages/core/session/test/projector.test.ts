import { describe, expect, it } from "vitest";
import {
	projectSessionRecords,
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
