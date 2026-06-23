/**
 * Bug regression: pino debug logs leak into the TUI viewport.
 *
 * In TUI mode, stderr is suppressed by run-agent.ts — pino writes to stderr
 * but those writes are silently dropped. Debug events go through traceEvent()
 * to the session JSONL (bus: "debug"), not through pino.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";

describe("logger: warn level does not emit debug lines to stderr", { tags: ["unit"] }, () => {
	let stderrWrites: string[] = [];
	let spy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stderrWrites = [];
		spy = vi.spyOn(process.stderr, "write").mockImplementation((data) => {
			stderrWrites.push(typeof data === "string" ? data : data.toString());
			return true;
		});
	});

	afterEach(() => {
		spy.mockRestore();
	});

	it("createLogger('warn') does not emit debug lines to stderr", () => {
		const log = createLogger("warn");
		log.debug({ src: "test" }, "should not appear");
		const debugLines = stderrWrites.filter((l) => l.includes('"level":20'));
		expect(debugLines).toHaveLength(0);
	});

	it("createLogger('warn') never emits to stderr in tests (baseline)", () => {
		const log = createLogger("warn");
		log.warn({ src: "test" }, "warn msg");
		log.debug({ src: "test" }, "debug msg — should not appear at warn level");
		const debugLines = stderrWrites.filter((l) => l.includes('"level":20'));
		expect(debugLines).toHaveLength(0);
	});
});
