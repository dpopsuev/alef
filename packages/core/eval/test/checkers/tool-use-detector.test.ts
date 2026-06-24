import { describe, expect, it } from "vitest";
import type { CheckerContext, CheckerResult } from "../../src/evaluation.js";
import type { SpanRecord } from "../../src/metrics.js";
import { toolCallsAreReal } from "../../src/checkers/tool-use-detector.js";

function span(name: string): SpanRecord {
	return { name, attributes: {}, status: "OK", durationMs: 0 };
}

function check(lastReply: string, spans: SpanRecord[] = [], prefix?: string): CheckerResult {
	return toolCallsAreReal(prefix).check({ workspace: "/tmp", lastReply, spans }) as CheckerResult;
}

describe("toolCallsAreReal", { tags: ["unit"] }, () => {
	it("passes when reply has no JSON tool calls", () => {
		expect(check("Here is the file content.").pass).toBe(true);
	});

	it("passes when reply has JSON but real tool spans exist", () => {
		expect(check('```json\n{"tool": "fs.read"}\n```', [span("fs.read")]).pass).toBe(true);
	});

	it("FAILS when reply has JSON tool calls but no tool spans", () => {
		const reply = `I'll explore with subagents.

\`\`\`json
[
  {"tool": "agent.run", "profile": "explore", "text": "Read packages/core/kernel/src/framework.ts"},
  {"tool": "agent.run", "profile": "explore", "text": "List all packages"}
]
\`\`\``;

		const result = check(reply);
		expect(result.pass).toBe(false);
		expect(result.score).toBe(0);
		expect(result.errors[0]).toContain("JSON text describing tool calls");
	});

	it("FAILS when reply has await-style pseudo-calls but no spans", () => {
		const reply = `\`\`\`ts
await agent.run({ profile: "explore", text: "Read README.md" })
await fs.read({ path: "src/main.ts" })
\`\`\``;
		expect(check(reply).pass).toBe(false);
	});

	it("FAILS when reply has inline JSON tool object but no spans", () => {
		expect(check('Let me call: {"name": "fs.read", "args": {"path": "/tmp/f.txt"}}').pass).toBe(false);
	});

	it("passes when reply is empty", () => {
		expect(check("").pass).toBe(true);
	});

	it("passes with no reply", () => {
		const result = toolCallsAreReal().check({ workspace: "/tmp", spans: [] }) as CheckerResult;
		expect(result.pass).toBe(true);
	});

	it("filters spans by prefix when specified", () => {
		const reply = '```json\n{"tool": "agent.run"}\n```';
		expect(check(reply, [span("fs.read")], "agent.").pass).toBe(false);
		expect(check(reply, [span("agent.run")], "agent.").pass).toBe(true);
	});
});
