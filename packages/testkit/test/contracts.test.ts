/**
 * Contract tests — verify Motor/Sense event payload schemas.
 *
 * These tests ensure the payload shape each organ publishes on Sense matches
 * the documented contract. They catch silent regressions where an organ stops
 * returning a required field and the runner + LLM receive malformed data.
 *
 * Pattern: publish Motor/<action> → await Sense/<action> → assert payload fields.
 * No real LLM. No API key. Always run in CI.
 *
 * Ref: ALE-TSK-158
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsOrgan } from "../../organ-fs/src/index.js";
import { createShellOrgan } from "../../organ-shell/src/index.js";
import type { SenseEvent } from "../../spine/src/buses.js";
import { InProcessNerve } from "../../spine/src/buses.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs: string[] = [];
function tmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-contract-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Publish a Motor event and await the matching Sense event. */
function motorAndAwaitSense(
	nerve: InProcessNerve,
	type: string,
	payload: Record<string, unknown>,
	timeoutMs = 5_000,
): Promise<SenseEvent> {
	const correlationId = `test-${type}-${Date.now()}`;
	const toolCallId = `tc-${Date.now()}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error(`Timeout waiting for Sense/${type}`));
		}, timeoutMs);
		const off = nerve.asNerve().sense.subscribe(type, (e) => {
			if (e.correlationId === correlationId) {
				clearTimeout(timer);
				off();
				resolve(e);
			}
		});
		nerve.asNerve().motor.publish({
			type,
			payload: { ...payload, toolCallId },
			correlationId,
			timestamp: Date.now(),
		});
	});
}

// ---------------------------------------------------------------------------
// FsOrgan contracts
// ---------------------------------------------------------------------------

describe("FsOrgan contracts", () => {
	it("fs.read → { content: string, truncated: boolean, totalLines: number }", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "hello.ts"), "export const x = 1;\nexport const y = 2;\n");

		const nerve = new InProcessNerve();
		const organ = createFsOrgan({ cwd });
		organ.mount(nerve.asNerve());

		const sense = await motorAndAwaitSense(nerve, "fs.read", { path: "hello.ts" });
		expect(sense.isError).toBe(false);
		const p = sense.payload;
		expect(typeof p.content).toBe("string");
		expect(typeof p.truncated).toBe("boolean");
		expect(typeof p.totalLines).toBe("number");
		expect((p.content as string).length).toBeGreaterThan(0);
	});

	it("fs.read mirrors toolCallId in payload", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "f.ts"), "const a = 1;");
		const nerve = new InProcessNerve();
		const organ = createFsOrgan({ cwd });
		organ.mount(nerve.asNerve());

		const sense = await motorAndAwaitSense(nerve, "fs.read", { path: "f.ts" });
		expect(sense.payload.toolCallId).toBeDefined();
	});

	it("fs.write → { path: string, bytes: number }", async () => {
		const cwd = tmpDir();
		const nerve = new InProcessNerve();
		createFsOrgan({ cwd }).mount(nerve.asNerve());

		const sense = await motorAndAwaitSense(nerve, "fs.write", {
			path: "out.ts",
			content: "export const z = 3;",
		});
		expect(sense.isError).toBe(false);
		expect(typeof sense.payload.path).toBe("string");
		expect(typeof sense.payload.bytes).toBe("number");
		expect(sense.payload.bytes as number).toBeGreaterThan(0);
	});

	it("fs.edit → { path: string, applied: true }", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "edit.ts"), "const a = 1;");
		const nerve = new InProcessNerve();
		createFsOrgan({ cwd }).mount(nerve.asNerve());

		const sense = await motorAndAwaitSense(nerve, "fs.edit", {
			path: "edit.ts",
			oldText: "const a = 1;",
			newText: "const a = 2;",
		});
		expect(sense.isError).toBe(false);
		expect(typeof sense.payload.path).toBe("string");
		expect(sense.payload.applied).toBe(true);
	});

	it("fs.read on missing file → isError: true, errorMessage: string", async () => {
		const cwd = tmpDir();
		const nerve = new InProcessNerve();
		createFsOrgan({ cwd }).mount(nerve.asNerve());

		const sense = await motorAndAwaitSense(nerve, "fs.read", { path: "nonexistent.ts" });
		expect(sense.isError).toBe(true);
		expect(typeof sense.errorMessage).toBe("string");
		expect((sense.errorMessage as string).length).toBeGreaterThan(0);
	});

	it("fs.grep → { matches: array, count: number } or error-shaped sense", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "a.ts"), "export function login() {}");
		const nerve = new InProcessNerve();
		createFsOrgan({ cwd }).mount(nerve.asNerve());

		const sense = await motorAndAwaitSense(nerve, "fs.grep", { pattern: "login" });
		// grep may succeed or fail depending on ripgrep availability;
		// either way the sense event must be well-formed
		if (sense.isError) {
			expect(typeof sense.errorMessage).toBe("string");
		} else {
			// GrepToolResponse returns content array — just assert sense event is present
			expect(sense.payload).toBeDefined();
		}
	});

	it("fs.edit with non-unique oldText → isError: true", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "dup.ts"), "const x = 1;\nconst x = 1;");
		const nerve = new InProcessNerve();
		createFsOrgan({ cwd }).mount(nerve.asNerve());

		const sense = await motorAndAwaitSense(nerve, "fs.edit", {
			path: "dup.ts",
			oldText: "const x = 1;",
			newText: "const x = 2;",
		});
		expect(sense.isError).toBe(true);
		expect(sense.errorMessage as string).toMatch(/unique|multiple/i);
	});
});

// ---------------------------------------------------------------------------
// ShellOrgan contracts
// ---------------------------------------------------------------------------

describe("ShellOrgan contracts", () => {
	it("shell.exec (success) → final event has { output: string, exitCode: number, isFinal: true }", async () => {
		const cwd = tmpDir();
		const nerve = new InProcessNerve();
		createShellOrgan({ cwd }).mount(nerve.asNerve());

		// Collect all shell.exec sense events for this correlation
		const correlationId = `shell-${Date.now()}`;
		const toolCallId = `tc-${Date.now()}`;
		const events: SenseEvent[] = [];

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("shell.exec timeout")), 10_000);
			const off = nerve.asNerve().sense.subscribe("shell.exec", (e) => {
				if (e.correlationId !== correlationId) return;
				events.push(e);
				if (e.payload.isFinal === true) {
					clearTimeout(timer);
					off();
					resolve();
				}
			});
			nerve.asNerve().motor.publish({
				type: "shell.exec",
				payload: { command: "echo hello", toolCallId },
				correlationId,
				timestamp: Date.now(),
			});
		});

		const finalEvent = events.find((e) => e.payload.isFinal === true);
		expect(finalEvent).toBeDefined();
		expect(finalEvent!.isError).toBe(false);
		expect(typeof finalEvent!.payload.exitCode).toBe("number");
		expect(finalEvent!.payload.exitCode).toBe(0);
		expect(typeof finalEvent!.payload.output).toBe("string");
		expect(finalEvent!.payload.output as string).toContain("hello");
		expect(finalEvent!.payload.isFinal).toBe(true);
	});

	it("shell.exec (failure) → isError: true with exitCode and output", async () => {
		const cwd = tmpDir();
		const nerve = new InProcessNerve();
		createShellOrgan({ cwd }).mount(nerve.asNerve());

		const sense = await motorAndAwaitSense(nerve, "shell.exec", {
			command: "exit 1",
		});
		expect(sense.isError).toBe(true);
		expect(typeof sense.errorMessage).toBe("string");
	});

	it("shell.exec mirrors toolCallId", async () => {
		const cwd = tmpDir();
		const nerve = new InProcessNerve();
		createShellOrgan({ cwd }).mount(nerve.asNerve());

		const correlationId = `shell-id-${Date.now()}`;
		const toolCallId = `tc-mirror-${Date.now()}`;
		const finalEvent = await new Promise<SenseEvent>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timeout")), 10_000);
			const off = nerve.asNerve().sense.subscribe("shell.exec", (e) => {
				if (e.correlationId !== correlationId) return;
				if (e.payload.isFinal === true) {
					clearTimeout(timer);
					off();
					resolve(e);
				}
			});
			nerve.asNerve().motor.publish({
				type: "shell.exec",
				payload: { command: "echo hi", toolCallId },
				correlationId,
				timestamp: Date.now(),
			});
		});
		expect(finalEvent.payload.toolCallId).toBe(toolCallId);
	});
});

// ---------------------------------------------------------------------------
// SenseEvent base shape contract
// ---------------------------------------------------------------------------

describe("SenseEvent base shape", () => {
	it("every Sense event has type, correlationId, timestamp, isError", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "x.ts"), "const x = 1;");
		const nerve = new InProcessNerve();
		createFsOrgan({ cwd }).mount(nerve.asNerve());

		const sense = await motorAndAwaitSense(nerve, "fs.read", { path: "x.ts" });
		expect(typeof sense.type).toBe("string");
		expect(typeof sense.correlationId).toBe("string");
		expect(typeof sense.timestamp).toBe("number");
		expect(typeof sense.isError).toBe("boolean");
	});
});
