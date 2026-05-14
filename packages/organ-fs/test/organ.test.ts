import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InProcessNerve } from "@dpopsuev/alef-spine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsOrgan } from "../src/organ.js";

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
	testDir = join(tmpdir(), `alef-fs-organ-test-${Date.now()}`);
	await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, corpus: nerve.asCorpusNerve(), cerebrum: nerve.asCerebrumNerve() };
}

function waitForSense(nerve: InProcessNerve, type: string): Promise<import("@dpopsuev/alef-spine").SenseEvent> {
	return new Promise((resolve) => {
		const unsub = nerve.asCerebrumNerve().sense.subscribe(type, (event) => {
			unsub();
			resolve(event);
		});
	});
}

function publishMotor(nerve: InProcessNerve, type: string, payload: Record<string, unknown>) {
	nerve.asCerebrumNerve().motor.publish({
		type,
		correlationId: `test-${Math.random().toString(36).slice(2)}`,
		timestamp: Date.now(),
		payload,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FsCorpusOrgan", () => {
	it("has kind=corpus, name=fs, and 3 tools", () => {
		const organ = createFsOrgan({ cwd: testDir });
		expect(organ.kind).toBe("corpus");
		expect(organ.name).toBe("fs");
		expect(organ.tools.map((t) => t.name)).toEqual(["fs.read", "fs.grep", "fs.find"]);
	});

	it("unmount unsubscribes all motor handlers", () => {
		const { nerve, corpus } = makeNerve();
		const organ = createFsOrgan({ cwd: testDir });
		const unmount = organ.mount(corpus);
		expect(nerve.listenerCount("motor", "fs.read")).toBe(1);
		unmount();
		expect(nerve.listenerCount("motor", "fs.read")).toBe(0);
		expect(nerve.listenerCount("motor", "fs.grep")).toBe(0);
		expect(nerve.listenerCount("motor", "fs.find")).toBe(0);
	});

	describe("fs.read", () => {
		it("reads a file and publishes Sense/fs.read", async () => {
			await writeFile(join(testDir, "hello.txt"), "line1\nline2\nline3\n");
			const { nerve, corpus } = makeNerve();
			const organ = createFsOrgan({ cwd: testDir });
			const unmount = organ.mount(corpus);

			const resultP = waitForSense(nerve, "fs.read");
			publishMotor(nerve, "fs.read", { path: "hello.txt" });
			const result = await resultP;

			expect(result.isError).toBe(false);
			expect(result.payload.content).toContain("line1");
			expect(result.payload.content).toContain("line3");
			unmount();
		});

		it("applies offset", async () => {
			await writeFile(join(testDir, "lines.txt"), "a\nb\nc\nd\n");
			const { nerve, corpus } = makeNerve();
			const organ = createFsOrgan({ cwd: testDir });
			const unmount = organ.mount(corpus);

			const resultP = waitForSense(nerve, "fs.read");
			publishMotor(nerve, "fs.read", { path: "lines.txt", offset: 3 });
			const result = await resultP;

			expect(result.isError).toBe(false);
			const content = result.payload.content as string;
			expect(content).not.toContain("a\n");
			expect(content).toContain("c");
			unmount();
		});

		it("publishes error on missing file", async () => {
			const { nerve, corpus } = makeNerve();
			const organ = createFsOrgan({ cwd: testDir });
			const unmount = organ.mount(corpus);

			const resultP = waitForSense(nerve, "fs.read");
			publishMotor(nerve, "fs.read", { path: "nonexistent.txt" });
			const result = await resultP;

			expect(result.isError).toBe(true);
			expect(result.errorMessage).toMatch(/ENOENT/);
			unmount();
		});

		it("mirrors correlationId from motor event", async () => {
			await writeFile(join(testDir, "foo.txt"), "foo");
			const { nerve, corpus } = makeNerve();
			const organ = createFsOrgan({ cwd: testDir });
			const unmount = organ.mount(corpus);
			const correlationId = "my-correlation-id";

			let received: import("@dpopsuev/alef-spine").SenseEvent | null = null;
			const unsub = nerve.asCerebrumNerve().sense.subscribe("fs.read", (e) => {
				received = e;
			});
			nerve.asCerebrumNerve().motor.publish({
				type: "fs.read",
				correlationId,
				timestamp: Date.now(),
				payload: { path: "foo.txt" },
			});
			await new Promise((r) => setTimeout(r, 50));

			expect(received).not.toBeNull();
			expect((received as unknown as import("@dpopsuev/alef-spine").SenseEvent).correlationId).toBe(correlationId);
			unsub();
			unmount();
		});
	});

	describe("fs.grep", () => {
		it("finds pattern matches and publishes Sense/fs.grep", async () => {
			await writeFile(join(testDir, "src.ts"), "const foo = 1;\nconst bar = 2;\n");
			const { nerve, corpus } = makeNerve();
			const organ = createFsOrgan({ cwd: testDir });
			const unmount = organ.mount(corpus);

			const resultP = waitForSense(nerve, "fs.grep");
			publishMotor(nerve, "fs.grep", { pattern: "foo" });
			const result = await resultP;

			expect(result.isError).toBe(false);
			unmount();
		});
	});

	describe("fs.find", () => {
		it("finds files by pattern and publishes Sense/fs.find", async () => {
			await writeFile(join(testDir, "a.ts"), "");
			await writeFile(join(testDir, "b.ts"), "");
			await writeFile(join(testDir, "c.txt"), "");
			const { nerve, corpus } = makeNerve();
			const organ = createFsOrgan({ cwd: testDir });
			const unmount = organ.mount(corpus);

			const resultP = waitForSense(nerve, "fs.find");
			publishMotor(nerve, "fs.find", { pattern: "*.ts" });
			const result = await resultP;

			expect(result.isError).toBe(false);
			unmount();
		});
	});
});
