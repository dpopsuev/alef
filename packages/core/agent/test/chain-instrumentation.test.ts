import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const AGENT_SRC = resolve(import.meta.dirname, "../src");
const CLI_CLIENT = resolve(import.meta.dirname, "../../../cli/src/client");

/** Every link in the message round-trip chain must have a traceEvent call. */
describe("chain instrumentation coverage", { tags: ["unit"] }, () => {
	const required = [
		{ file: resolve(AGENT_SRC, "assemble.ts"), event: "observer:convert" },
		{ file: resolve(AGENT_SRC, "assemble.ts"), event: "observer:deliver" },
		{ file: resolve(AGENT_SRC, "assemble.ts"), event: "observer:turn-complete" },
		{ file: resolve(CLI_CLIENT, "runner.ts"), event: "tui:observer" },
		{ file: resolve(CLI_CLIENT, "events.ts"), event: "tui:dispatch" },
	];

	for (const { file, event } of required) {
		const shortFile = file.split("/src/").pop() ?? file;
		it(`${shortFile} must contain traceEvent("${event}")`, () => {
			const content = readFileSync(file, "utf-8");
			expect(content).toContain(`traceEvent("${event}"`);
		});
	}
});
