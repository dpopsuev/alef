import { describe, expect, it } from "vitest";
import {
	formatPreviewLines,
	projectSessionRecords,
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

describe("formatPreviewLines", { tags: ["unit"] }, () => {
	it("renders block kinds with picker prefixes", () => {
		const lines = formatPreviewLines(
			[
				{ kind: "user", text: "ask" },
				{ kind: "assistant", text: "reply" },
				{ kind: "tool", name: "fs.read", summary: "/tmp/a.ts" },
				{ kind: "state", label: "status", text: "running" },
			],
			10,
		);

		expect(lines[0]).toBe("  ▸ ask");
		expect(lines[1]).toBe("  ◂ reply");
		expect(lines[2]).toBe("  ● fs.read /tmp/a.ts");
		expect(lines[3]).toBe("  ▨ status: running");
	});

	it("returns the last maxLines transcript lines", () => {
		const blocks = Array.from({ length: 8 }, (_, index) => ({
			kind: "user" as const,
			text: `msg ${index}`,
		}));

		const lines = formatPreviewLines(blocks, 5);

		expect(lines).toHaveLength(5);
		expect(lines[0]).toContain("msg 3");
		expect(lines[4]).toContain("msg 7");
	});

	it("keeps the plan block at the top within maxLines", () => {
		const blocks = projectSessionRecords(
			Array.from({ length: 6 }, (_, index) => rec("event", "llm.input", { text: `msg ${index}` })),
			{
				plan: {
					phase: "ship",
					desired: "projector module",
					current: "tests",
					stepSummary: "1/2 done",
				},
			},
		);

		const lines = formatPreviewLines(blocks, 5);

		expect(lines[0]).toContain("◆ plan [ship]");
		expect(lines[0]).toContain("projector module");
		expect(lines[1]).toBe("    tests");
		expect(lines[2]).toBe("    1/2 done");
		expect(lines).toHaveLength(5);
		expect(lines[3]).toContain("msg 4");
		expect(lines[4]).toContain("msg 5");
	});
});
