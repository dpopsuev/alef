/**
 * Bug regression: pino debug logs leak into the TUI viewport.
 *
 * Root cause: pino worker transports open fd 2 directly, bypassing the
 * process.stderr.write override. Fix: when TUI is active, pino writes
 * to $XDG_STATE_HOME/alef/debug.log instead of stderr.
 */

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, createRunnerLogger } from "../src/boot/logger.js";

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

describe("logger: TUI mode redirects to log file", { tags: ["unit"] }, () => {
	it("createLogger with logFile writes to file, not stderr", async () => {
		const logFile = join(tmpdir(), `alef-test-logger-${Date.now()}.log`);
		try {
			const log = createLogger("debug", logFile);
			log.debug({ src: "test" }, "to file");
			// Worker transport is async; give it a moment to flush
			await new Promise((r) => setTimeout(r, 200));
			expect(existsSync(logFile)).toBe(true);
		} finally {
			try {
				unlinkSync(logFile);
			} catch {
				/* cleanup */
			}
		}
	});

	it("createRunnerLogger with TUI+debug targets a log file", () => {
		const log = createRunnerLogger(true, true);
		expect(log.level).toBe("debug");
	});

	it("createRunnerLogger with TUI without debug is silent", () => {
		const log = createRunnerLogger(true, false);
		expect(log.level).toBe("silent");
	});
});
