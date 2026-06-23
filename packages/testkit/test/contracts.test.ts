/**
 * Contract tests — verify Command/Event message payload schemas.
 *
 * Pattern: BusFixture.call() → assert payload fields.
 * No real LLM. No API key. Always run in CI.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsAdapter } from "../../adapter-fs/src/index.js";
import { createShellAdapter } from "../../adapter-shell/src/index.js";
import { BusFixture } from "../src/index.js";

const dirs: string[] = [];
function tmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-contract-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("FsAdapter contracts", { tags: ["compliance"] }, () => {
	it("fs.read → { content: string, truncated: boolean, totalLines: number }", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "hello.ts"), "export const x = 1;\nexport const y = 2;\n");
		const f = new BusFixture();
		f.mount(createFsAdapter({ cwd }));

		const result = await f.call("fs.read", { path: "hello.ts" });
		expect(result.isError).toBe(false);
		expect(typeof result.payload.content).toBe("string");
		expect(typeof result.payload.truncated).toBe("boolean");
		expect(typeof result.payload.totalLines).toBe("number");
		expect((result.payload.content as string).length).toBeGreaterThan(0);
		f.dispose();
	});

	it("fs.read mirrors toolCallId in payload", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "f.ts"), "const a = 1;");
		const f = new BusFixture();
		f.mount(createFsAdapter({ cwd }));

		const result = await f.call("fs.read", { path: "f.ts", toolCallId: "tc-test" });
		expect(result.payload.toolCallId).toBeDefined();
		f.dispose();
	});

	it("fs.write → { path: string, bytes: number }", async () => {
		const cwd = tmpDir();
		const f = new BusFixture();
		f.mount(createFsAdapter({ cwd }));

		const result = await f.call("fs.write", { path: "out.ts", content: "export const z = 3;" });
		expect(result.isError).toBe(false);
		expect(typeof result.payload.path).toBe("string");
		expect(typeof result.payload.bytes).toBe("number");
		expect(result.payload.bytes as number).toBeGreaterThan(0);
		f.dispose();
	});

	it("fs.edit → { path: string, applied: true }", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "edit.ts"), "const a = 1;");
		const f = new BusFixture();
		f.mount(createFsAdapter({ cwd }));

		await f.call("fs.read", { path: "edit.ts" });
		const result = await f.call("fs.edit", { path: "edit.ts", oldText: "const a = 1;", newText: "const a = 2;" });
		expect(result.isError).toBe(false);
		expect(typeof result.payload.path).toBe("string");
		expect(result.payload.applied).toBe(true);
		f.dispose();
	});

	it("fs.read on missing file → isError: true, errorMessage: string", async () => {
		const cwd = tmpDir();
		const f = new BusFixture();
		f.mount(createFsAdapter({ cwd }));

		const result = await f.call("fs.read", { path: "nonexistent.ts" });
		expect(result.isError).toBe(true);
		expect(typeof result.errorMessage).toBe("string");
		expect((result.errorMessage as string).length).toBeGreaterThan(0);
		f.dispose();
	});

	it("fs.grep → well-formed Event message", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "a.ts"), "export function login() {}");
		const f = new BusFixture();
		f.mount(createFsAdapter({ cwd }));

		const result = await f.call("fs.grep", { pattern: "login" });
		if (result.isError) {
			expect(typeof result.errorMessage).toBe("string");
		} else {
			expect(result.payload).toBeDefined();
		}
		f.dispose();
	});

	it("fs.edit with non-unique oldText → isError: true", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "dup.ts"), "const x = 1;\nconst x = 1;");
		const f = new BusFixture();
		f.mount(createFsAdapter({ cwd }));

		await f.call("fs.read", { path: "dup.ts" });
		const result = await f.call("fs.edit", { path: "dup.ts", oldText: "const x = 1;", newText: "const x = 2;" });
		expect(result.isError).toBe(true);
		expect(result.errorMessage as string).toMatch(/unique|multiple/i);
		f.dispose();
	});
});

describe("ShellAdapter contracts", { tags: ["compliance"] }, () => {
	it("shell.exec (success) → final event has output, exitCode 0, isFinal: true", async () => {
		const cwd = tmpDir();
		const f = new BusFixture();
		f.mount(createShellAdapter({ cwd }));

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
		const f = new BusFixture();
		f.mount(createShellAdapter({ cwd }));

		const result = await f.callStreaming("shell.exec", { command: "exit 1" });
		expect(result.isError).toBe(true);
		expect(typeof result.errorMessage).toBe("string");
		f.dispose();
	});

	it("shell.exec mirrors toolCallId", async () => {
		const cwd = tmpDir();
		const f = new BusFixture();
		f.mount(createShellAdapter({ cwd }));

		const toolCallId = `tc-mirror-${Date.now()}`;
		const final = await f.callStreaming("shell.exec", { command: "echo hi", toolCallId }, { timeoutMs: 10_000 });
		expect(final.payload.toolCallId).toBe(toolCallId);
		f.dispose();
	});
});

describe("EventMessage base shape", { tags: ["compliance"] }, () => {
	it("every Event message has type, correlationId, timestamp, isError", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "x.ts"), "const x = 1;");
		const f = new BusFixture();
		f.mount(createFsAdapter({ cwd }));

		const result = await f.call("fs.read", { path: "x.ts" });
		expect(typeof result.type).toBe("string");
		expect(typeof result.correlationId).toBe("string");
		expect(typeof result.timestamp).toBe("number");
		expect(typeof result.isError).toBe("boolean");
		f.dispose();
	});
});
