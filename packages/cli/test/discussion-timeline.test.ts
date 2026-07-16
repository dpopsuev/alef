import { describe, expect, it } from "vitest";
import { buildDiscussionTimeline } from "../src/client/runner.js";

describe("buildDiscussionTimeline", () => {
	it("merges discourse messages with runtime tool history in timestamp order", () => {
		const timeline = buildDiscussionTimeline(
			[
				{ author: "@you", role: "user", text: "start", timestamp: 1000 },
				{ author: "@alef", role: "assistant", text: "done", timestamp: 3000 },
			],
			[{ name: "fs.read", keyArg: "README.md", timestamp: 2000 }],
		);

		expect(timeline).toEqual([
			{
				kind: "message",
				message: { author: "@you", role: "user", text: "start", timestamp: 1000 },
			},
			{
				kind: "tool",
				tool: { name: "fs.read", keyArg: "README.md", timestamp: 2000 },
			},
			{
				kind: "message",
				message: { author: "@alef", role: "assistant", text: "done", timestamp: 3000 },
			},
		]);
	});
});
