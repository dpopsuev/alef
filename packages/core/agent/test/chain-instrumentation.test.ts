import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../..");
const ENGINE_SRC = resolve(ROOT, "packages/core/engine/src");
const CLI_CLIENT = resolve(ROOT, "packages/cli/src/client");

/** Every link in the message round-trip chain must be observable. */
describe("chain instrumentation coverage", { tags: ["unit"] }, () => {
	it("Agent.asBus() applies withAutoTrace middleware", () => {
		const content = readFileSync(resolve(ENGINE_SRC, "agent.ts"), "utf-8");
		expect(content).toContain("withAutoTrace");
	});

	it("TUI observer callback has traceEvent", () => {
		const content = readFileSync(resolve(CLI_CLIENT, "runner.ts"), "utf-8");
		expect(content).toContain('traceEvent("tui:observer"');
	});

	it("TUI dispatch has traceEvent", () => {
		const content = readFileSync(resolve(CLI_CLIENT, "events.ts"), "utf-8");
		expect(content).toContain('traceEvent("tui:dispatch"');
	});
});
