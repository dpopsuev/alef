import { describe, expect, it } from "vitest";
import { StreamRuleWatcher } from "../src/stream-turn.js";

describe("StreamRuleWatcher", { tags: ["unit"] }, () => {
	it("matches accumulated text and returns the rule once", () => {
		const watcher = new StreamRuleWatcher([
			{ id: "no-apology", pattern: "I apologize", on: "text", message: "Do not apologize; continue." },
		]);
		expect(watcher.push("text", "Hello, ")).toBeUndefined();
		expect(watcher.push("text", "I apologize")).toMatchObject({ id: "no-apology" });
		expect(watcher.push("text", " for that")).toMatchObject({ id: "no-apology" });
	});

	it("ignores text when rule is thinking-only", () => {
		const watcher = new StreamRuleWatcher([
			{ id: "think-loop", pattern: "spin forever", on: "thinking", message: "Stop looping." },
		]);
		expect(watcher.push("text", "spin forever")).toBeUndefined();
		expect(watcher.push("thinking", "I will spin forever")).toMatchObject({ id: "think-loop" });
	});

	it("supports RegExp patterns and both channel", () => {
		const watcher = new StreamRuleWatcher([
			{ id: "leak", pattern: /SECRET_\d+/, on: "both", message: "Redact secrets." },
		]);
		expect(watcher.push("thinking", "consider ")).toBeUndefined();
		expect(watcher.push("text", "SECRET_42")).toMatchObject({ id: "leak" });
	});

	it("is dormant with empty rules", () => {
		const watcher = new StreamRuleWatcher([]);
		expect(watcher.push("text", "anything")).toBeUndefined();
	});
});
