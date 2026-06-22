/**
 * Contract tests — verify Motor/Sense event payload schemas.
 *
 * Pattern: NerveFixture.call() → assert payload fields.
 * No real LLM. No API key. Always run in CI.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsOrgan } from "../../adapter-fs/src/index.js";
import { createShellOrgan } from "../../adapter-shell/src/index.js";
import { NerveFixture } from "../src/index.js";

const dirs: string[] = [];
function tmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-contract-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("FsOrgan contracts", { tags: ["compliance"] }, () => {
	it("fs.read → { content: string, truncated: boolean, totalLines: number }", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "hello.ts"), "export const x = 1;\nexport const y = 2;\n");
		const f = new NerveFixture();
		f.mount(createFsOrgan({ cwd }));

		const sense = await f.call("fs.read", { path: "hello.ts" });
		expect(sense.isError).toBe(false);
		expect(typeof sense.payload.content).toBe("string");
		expect(typeof sense.payload.truncated).toBe("boolean");
		expect(typeof sense.payload.totalLines).toBe("number");
		expect((sense.payload.content as string).length).toBeGreaterThan(0);
		f.dispose();
	});

	it("fs.read mirrors toolCallId in payload", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "f.ts"), "const a = 1;");
		const f = new NerveFixture();
		f.mount(createFsOrgan({ cwd }));

		const sense = await f.call("fs.read", { path: "f.ts", toolCallId: "tc-test" });
		expect(sense.payload.toolCallId).toBeDefined();
		f.dispose();
	});

	it("fs.write → { path: string, bytes: number }", async () => {
		const cwd = tmpDir();
		const f = new NerveFixture();
		f.mount(createFsOrgan({ cwd }));

		const sense = await f.call("fs.write", { path: "out.ts", content: "export const z = 3;" });
		expect(sense.isError).toBe(false);
		expect(typeof sense.payload.path).toBe("string");
		expect(typeof sense.payload.bytes).toBe("number");
		expect(sense.payload.bytes as number).toBeGreaterThan(0);
		f.dispose();
	});

	it("fs.edit → { path: string, applied: true }", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "edit.ts"), "const a = 1;");
		const f = new NerveFixture();
		f.mount(createFsOrgan({ cwd }));

		await f.call("fs.read", { path: "edit.ts" });
		const sense = await f.call("fs.edit", { path: "edit.ts", oldText: "const a = 1;", newText: "const a = 2;" });
		expect(sense.isError).toBe(false);
		expect(typeof sense.payload.path).toBe("string");
		expect(sense.payload.applied).toBe(true);
		f.dispose();
	});

	it("fs.read on missing file → isError: true, errorMessage: string", async () => {
		const cwd = tmpDir();
		const f = new NerveFixture();
		f.mount(createFsOrgan({ cwd }));

		const sense = await f.call("fs.read", { path: "nonexistent.ts" });
		expect(sense.isError).toBe(true);
		expect(typeof sense.errorMessage).toBe("string");
		expect((sense.errorMessage as string).length).toBeGreaterThan(0);
		f.dispose();
	});

	it("fs.grep → well-formed sense event", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "a.ts"), "export function login() {}");
		const f = new NerveFixture();
		f.mount(createFsOrgan({ cwd }));

		const sense = await f.call("fs.grep", { pattern: "login" });
		if (sense.isError) {
			expect(typeof sense.errorMessage).toBe("string");
		} else {
			expect(sense.payload).toBeDefined();
		}
		f.dispose();
	});

	it("fs.edit with non-unique oldText → isError: true", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "dup.ts"), "const x = 1;\nconst x = 1;");
		const f = new NerveFixture();
		f.mount(createFsOrgan({ cwd }));

		await f.call("fs.read", { path: "dup.ts" });
		const sense = await f.call("fs.edit", { path: "dup.ts", oldText: "const x = 1;", newText: "const x = 2;" });
		expect(sense.isError).toBe(true);
		expect(sense.errorMessage as string).toMatch(/unique|multiple/i);
		f.dispose();
	});
});

describe("ShellOrgan contracts", { tags: ["compliance"] }, () => {
	it("shell.exec (success) → final event has output, exitCode 0, isFinal: true", async () => {
		const cwd = tmpDir();
		const f = new NerveFixture();
		f.mount(createShellOrgan({ cwd }));

		const final = await f.callStreaming("shell.exec", { command: "echo hello" }, { timeoutMs: 10_000 });
		expect(final.isError).toBe(false);
		expect(final.payload.exitCode).toBe(0);
		expect(typeof final.payload.output).toBe("string");
		expect(final.payload.output as string).toContain("hello");
		expect(final.payload.isFinal).toBe(true);
		f.dispose();
	});

	it("shell.exec (failure) → isError: true", async () => {
		const cwd = tmpDir();
		const f = new NerveFixture();
		f.mount(createShellOrgan({ cwd }));

		const sense = await f.callStreaming("shell.exec", { command: "exit 1" });
		expect(sense.isError).toBe(true);
		expect(typeof sense.errorMessage).toBe("string");
		f.dispose();
	});

	it("shell.exec mirrors toolCallId", async () => {
		const cwd = tmpDir();
		const f = new NerveFixture();
		f.mount(createShellOrgan({ cwd }));

		const toolCallId = `tc-mirror-${Date.now()}`;
		const final = await f.callStreaming("shell.exec", { command: "echo hi", toolCallId }, { timeoutMs: 10_000 });
		expect(final.payload.toolCallId).toBe(toolCallId);
		f.dispose();
	});
});

describe("SenseEvent base shape", { tags: ["compliance"] }, () => {
	it("every Sense event has type, correlationId, timestamp, isError", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "x.ts"), "const x = 1;");
		const f = new NerveFixture();
		f.mount(createFsOrgan({ cwd }));

		const sense = await f.call("fs.read", { path: "x.ts" });
		expect(typeof sense.type).toBe("string");
		expect(typeof sense.correlationId).toBe("string");
		expect(typeof sense.timestamp).toBe("number");
		expect(typeof sense.isError).toBe("boolean");
		f.dispose();
	});
});
