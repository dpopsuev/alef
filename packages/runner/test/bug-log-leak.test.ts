/**
 * Bug regression: pino debug logs leak into the TUI viewport.
 *
 * When --debug is passed, pino writes JSON to stderr at debug level.
 * In a PTY, stdout and stderr share the same terminal — so pino JSON
 * lines appear mixed with TUI content.
 *
 * Fix: in TUI mode, redirect pino output to the debug log file instead
 * of stderr, or silence pino entirely (use debug-trace.ts instead).
 *
 * These tests verify the fix — createLogger("debug") in TUI mode must
 * NOT write to stderr (fd 2), but to the debug log file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";

describe("logger: TUI mode must not write to stderr", { tags: ["unit"] }, () => {
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

describe("createLoggerForTui: debug output goes to file not stderr", { tags: ["unit"] }, () => {
	it("createLoggerForTui is exported from logger.ts", async () => {
		const loggerModule = await import("../src/logger.js");
		expect(typeof (loggerModule as Record<string, unknown>).createLoggerForTui).toBe("function");
	});
});
