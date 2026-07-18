import { describe, expect, it } from "vitest";
import { AgentCard, type AgentCardTheme } from "../src/components/agent-card.js";

const theme: AgentCardTheme = {
	primary: (s) => s,
	secondary: (s) => s,
	muted: (s) => s,
	accent: (s) => s,
	identity: (s) => s,
};

describe("AgentCard", { tags: ["unit"] }, () => {
	it("renders a single line when not focused", () => {
		const card = new AgentCard(theme, {
			name: "agent.run",
			keyArg: "explore",
			args: { text: "hi" },
			elapsedMs: 1200,
			inputTokens: 100,
			outputTokens: 50,
			lastChunk: "streaming chunk that must stay hidden",
			spinner: "●",
			children: [
				{
					id: "c1",
					name: "fs.read",
					keyArg: "a.ts",
					args: { path: "a.ts" },
					elapsedMs: 10,
					depth: 0,
					spinner: "●",
				},
			],
		});
		const lines = card.render(80);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("agent.run");
		expect(lines[0]).toContain("1 tool");
		expect(lines.join("\n")).not.toContain("streaming chunk");
		expect(lines.join("\n")).not.toContain("fs.read");
	});

	it("reveals children and chunk when focused", () => {
		const card = new AgentCard(theme, {
			name: "agent.run",
			keyArg: "",
			args: {},
			elapsedMs: 500,
			inputTokens: 10,
			outputTokens: 5,
			lastChunk: "streaming chunk visible on focus",
			spinner: "●",
			children: [
				{
					id: "c1",
					name: "fs.read",
					keyArg: "a.ts",
					args: { path: "a.ts" },
					elapsedMs: 10,
					depth: 0,
					spinner: "●",
				},
			],
		});
		card.focused = true;
		const lines = card.render(80);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.some((line) => line.includes("streaming chunk visible on focus"))).toBe(true);
		expect(lines.some((line) => line.includes("fs.read"))).toBe(true);
	});
});
