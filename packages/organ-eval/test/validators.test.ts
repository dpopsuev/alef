import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "../src/types.js";
import { runValidators } from "../src/validators.js";

function motorEvent(type: string, text?: string): TranscriptEvent {
	return { bus: "motor", type, text };
}
function senseEvent(type: string, text?: string): TranscriptEvent {
	return { bus: "sense", type, text };
}

describe("runValidators", { tags: ["unit"] }, () => {
	it("returns empty array when no validators", () => {
		expect(runValidators([motorEvent("llm.response", "hello")], [])).toEqual([]);
	});

	it("contains: passes when text present", () => {
		const t = [motorEvent("llm.response", "the answer is 42")];
		expect(runValidators(t, [{ type: "contains", value: "answer" }])).toEqual([]);
	});

	it("contains: fails when text absent", () => {
		const t = [motorEvent("llm.response", "nothing here")];
		const f = runValidators(t, [{ type: "contains", value: "answer" }]);
		expect(f).toHaveLength(1);
		expect(f[0]).toMatch(/contain.*answer/);
	});

	it("not_contains: passes when text absent", () => {
		const t = [motorEvent("llm.response", "safe response")];
		expect(runValidators(t, [{ type: "not_contains", value: "error" }])).toEqual([]);
	});

	it("not_contains: fails when text present", () => {
		const t = [motorEvent("llm.response", "an error occurred")];
		const f = runValidators(t, [{ type: "not_contains", value: "error" }]);
		expect(f).toHaveLength(1);
	});

	it("tool_called: passes when tool appears in motor bus", () => {
		const t = [motorEvent("fs.read"), motorEvent("llm.response", "done")];
		expect(runValidators(t, [{ type: "tool_called", value: "fs.read" }])).toEqual([]);
	});

	it("tool_called: fails when tool not in transcript", () => {
		const t = [motorEvent("llm.response", "done")];
		const f = runValidators(t, [{ type: "tool_called", value: "fs.read" }]);
		expect(f).toHaveLength(1);
		expect(f[0]).toMatch(/fs\.read/);
	});

	it("tool_called: ignores sense bus events for same type", () => {
		const t = [senseEvent("fs.read", '{"content":"data"}'), motorEvent("llm.response", "ok")];
		const f = runValidators(t, [{ type: "tool_called", value: "fs.read" }]);
		expect(f).toHaveLength(1); // sense doesn't count — must be motor
	});

	it("multiple validators: all failures collected", () => {
		const t = [motorEvent("llm.response", "hello")];
		const f = runValidators(t, [
			{ type: "contains", value: "MISSING" },
			{ type: "tool_called", value: "shell.exec" },
		]);
		expect(f).toHaveLength(2);
	});

	it("multiple validators: one fail one pass", () => {
		const t = [motorEvent("llm.response", "hello world"), motorEvent("shell.exec")];
		const f = runValidators(t, [
			{ type: "contains", value: "hello" }, // passes
			{ type: "tool_called", value: "shell.exec" }, // passes
			{ type: "contains", value: "MISSING" }, // fails
		]);
		expect(f).toHaveLength(1);
	});

	it("exit_code: passes when exit code present in shell.exec sense text", () => {
		const t = [senseEvent("shell.exec", '{"exitCode":0,"output":"ok"}')];
		expect(runValidators(t, [{ type: "exit_code", value: "0" }])).toEqual([]);
	});

	it("exit_code: fails when exit code absent", () => {
		const t = [motorEvent("llm.response", "done")];
		const f = runValidators(t, [{ type: "exit_code", value: "0" }]);
		expect(f).toHaveLength(1);
	});
});
