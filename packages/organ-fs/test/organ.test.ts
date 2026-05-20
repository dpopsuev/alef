import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
	return { nerve, n: nerve.asNerve(), cerebrum: nerve.asNerve() };
}

function waitForSense(nerve: InProcessNerve, type: string): Promise<import("@dpopsuev/alef-spine").SenseEvent> {
	return new Promise((resolve) => {
		const unsub = nerve.asNerve().sense.subscribe(type, (event) => {
			unsub();
			resolve(event);
		});
	});
}

function publishMotor(nerve: InProcessNerve, type: string, payload: Record<string, unknown>) {
	nerve.asNerve().motor.publish({
		type,
		correlationId: `test-${Math.random().toString(36).slice(2)}`,
		payload,
	});
}

/** Mount a fresh FsOrgan on the nerve and return unmount. */
function createfsOrgan(nerve: InProcessNerve) {
	const organ = createFsOrgan({ cwd: testDir });
	const unmount = organ.mount(nerve.asNerve());
	return unmount;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FsCorpusOrgan", () => {
	it("has name=fs and 5 tools", () => {
		const organ = createFsOrgan({ cwd: testDir });
		expect(organ.name).toBe("fs");
		expect(organ.tools.map((t) => t.name)).toEqual(["fs.read", "fs.grep", "fs.find", "fs.write", "fs.edit"]);
	});

	it("unmount unsubscribes all motor handlers", () => {
		const { nerve } = makeNerve();
		const organ = createFsOrgan({ cwd: testDir });
		const unmount = organ.mount(nerve.asNerve());
		expect(nerve.listenerCount("motor", "fs.read")).toBe(1);
		unmount();
		expect(nerve.listenerCount("motor", "fs.read")).toBe(0);
		expect(nerve.listenerCount("motor", "fs.grep")).toBe(0);
		expect(nerve.listenerCount("motor", "fs.find")).toBe(0);
	});

	describe("fs.read", () => {
		it("reads a file and publishes Sense/fs.read", async () => {
			await writeFile(join(testDir, "hello.txt"), "line1\nline2\nline3\n");
			const { nerve } = makeNerve();
			const organ = createFsOrgan({ cwd: testDir });
			const unmount = organ.mount(nerve.asNerve());

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
			const { nerve } = makeNerve();
			const organ = createFsOrgan({ cwd: testDir });
			const unmount = organ.mount(nerve.asNerve());

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
			const { nerve } = makeNerve();
			const organ = createFsOrgan({ cwd: testDir });
			const unmount = organ.mount(nerve.asNerve());

			const resultP = waitForSense(nerve, "fs.read");
			publishMotor(nerve, "fs.read", { path: "nonexistent.txt" });
			const result = await resultP;

			expect(result.isError).toBe(true);
			expect(result.errorMessage).toMatch(/ENOENT/);
			unmount();
		});

		it("mirrors correlationId from motor event", async () => {
			await writeFile(join(testDir, "foo.txt"), "foo");
			const { nerve } = makeNerve();
			const organ = createFsOrgan({ cwd: testDir });
			const unmount = organ.mount(nerve.asNerve());
			const correlationId = "my-correlation-id";

			let received: import("@dpopsuev/alef-spine").SenseEvent | null = null;
			const unsub = nerve.asNerve().sense.subscribe("fs.read", (e) => {
				received = e;
			});
			nerve.asNerve().motor.publish({
				type: "fs.read",
				correlationId,
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
			const { nerve } = makeNerve();
			const organ = createFsOrgan({ cwd: testDir });
			const unmount = organ.mount(nerve.asNerve());

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
			const { nerve } = makeNerve();
			const organ = createFsOrgan({ cwd: testDir });
			const unmount = organ.mount(nerve.asNerve());

			const resultP = waitForSense(nerve, "fs.find");
			publishMotor(nerve, "fs.find", { pattern: "*.ts" });
			const result = await resultP;

			expect(result.isError).toBe(false);
			unmount();
		});
	});

	describe("fs.write", () => {
		it("creates a file and returns bytes written", async () => {
			const { nerve } = makeNerve();
			createfsOrgan(nerve);

			const resultP = waitForSense(nerve, "fs.write");
			publishMotor(nerve, "fs.write", { path: "hello.txt", content: "hello world" });
			const result = await resultP;

			expect(result.isError).toBe(false);
			expect(result.payload.bytes).toBe(11);
			const written = await readFile(join(testDir, "hello.txt"), "utf-8");
			expect(written).toBe("hello world");
		});

		it("overwrites an existing file", async () => {
			await writeFile(join(testDir, "existing.txt"), "old content");
			const { nerve } = makeNerve();
			createfsOrgan(nerve);

			const resultP = waitForSense(nerve, "fs.write");
			publishMotor(nerve, "fs.write", { path: "existing.txt", content: "new content" });
			await resultP;

			expect(await readFile(join(testDir, "existing.txt"), "utf-8")).toBe("new content");
		});
	});

	describe("fs.edit", () => {
		it("replaces first occurrence of oldText with newText", async () => {
			await writeFile(join(testDir, "source.ts"), "const x = 1;\nconst y = 2;");
			const { nerve } = makeNerve();
			createfsOrgan(nerve);

			const resultP = waitForSense(nerve, "fs.edit");
			publishMotor(nerve, "fs.edit", { path: "source.ts", oldText: "const x = 1;", newText: "const x = 99;" });
			const result = await resultP;

			expect(result.isError).toBe(false);
			expect(result.payload.applied).toBe(true);
			const after = await readFile(join(testDir, "source.ts"), "utf-8");
			expect(after).toBe("const x = 99;\nconst y = 2;");
		});

		it("errors when oldText is not found", async () => {
			await writeFile(join(testDir, "source.ts"), "const x = 1;");
			const { nerve } = makeNerve();
			createfsOrgan(nerve);

			const resultP = waitForSense(nerve, "fs.edit");
			publishMotor(nerve, "fs.edit", { path: "source.ts", oldText: "not here", newText: "x" });
			const result = await resultP;

			expect(result.isError).toBe(true);
			expect(result.errorMessage).toMatch(/not found/);
		});

		it("errors when oldText matches multiple locations", async () => {
			await writeFile(join(testDir, "dup.ts"), "foo\nfoo");
			const { nerve } = makeNerve();
			createfsOrgan(nerve);

			const resultP = waitForSense(nerve, "fs.edit");
			publishMotor(nerve, "fs.edit", { path: "dup.ts", oldText: "foo", newText: "bar" });
			const result = await resultP;

			expect(result.isError).toBe(true);
			expect(result.errorMessage).toMatch(/multiple/);
		});
	});

	describe("cache", () => {
		it("fs.read result is served from cache on second call", async () => {
			const filePath = join(testDir, "cached.txt");
			await writeFile(filePath, "v1");
			const { nerve } = makeNerve();
			createfsOrgan(nerve);

			// Subscribe before publishing — required for both cached and non-cached paths.
			const r1p = waitForSense(nerve, "fs.read");
			publishMotor(nerve, "fs.read", { path: filePath });
			const r1 = await r1p;
			expect((r1.payload.content as string).trim()).toBe("v1");

			// Mutate on disk — cache should still return v1.
			await writeFile(filePath, "v2-on-disk");
			const r2p = waitForSense(nerve, "fs.read");
			publishMotor(nerve, "fs.read", { path: filePath });
			const r2 = await r2p;
			expect((r2.payload.content as string).trim()).toBe("v1");
		});

		it("fs.write invalidates the fs.read cache", async () => {
			const filePath = join(testDir, "inv.txt");
			await writeFile(filePath, "original");
			const { nerve } = makeNerve();
			createfsOrgan(nerve);

			// Populate cache.
			const r1p = waitForSense(nerve, "fs.read");
			publishMotor(nerve, "fs.read", { path: filePath });
			const r1 = await r1p;
			expect((r1.payload.content as string).trim()).toBe("original");

			// Write new content — invalidates cache.
			const wp = waitForSense(nerve, "fs.write");
			publishMotor(nerve, "fs.write", { path: filePath, content: "updated" });
			await wp;

			// Next read should hit disk.
			const r2p = waitForSense(nerve, "fs.read");
			publishMotor(nerve, "fs.read", { path: filePath });
			const r2 = await r2p;
			expect((r2.payload.content as string).trim()).toBe("updated");
		});
	});
});

// ---------------------------------------------------------------------------
// Concurrent write serialization
// ---------------------------------------------------------------------------

describe("write serialization — file mutation queue", () => {
	it("serializes concurrent fs.write calls on the same path", async () => {
		const { nerve } = makeNerve();
		const organ = createFsOrgan({ cwd: testDir });
		const unmount = organ.mount(nerve.asNerve());

		const filePath = "concurrent.txt";
		const abs = join(testDir, filePath);
		await writeFile(abs, "");

		// Fire two writes concurrently — second must see first committed.
		const order: string[] = [];

		const p1 = new Promise<void>((resolve) => {
			const unsub = nerve.asNerve().sense.subscribe("fs.write", (event) => {
				if ((event.payload as { path?: string }).path === filePath) {
					order.push("write-1");
					unsub();
					resolve();
				}
			});
		});
		const p2 = new Promise<void>((resolve) => {
			let count = 0;
			const unsub = nerve.asNerve().sense.subscribe("fs.write", () => {
				count++;
				if (count === 2) {
					order.push("write-2");
					unsub();
					resolve();
				}
			});
		});

		nerve.publishMotor({ type: "fs.write", correlationId: "c1", payload: { path: filePath, content: "from-1" } });
		nerve.publishMotor({ type: "fs.write", correlationId: "c2", payload: { path: filePath, content: "from-2" } });

		await Promise.all([p1, p2]);

		// Both writes settled — file must have one of the two values (not corrupted).
		const content = await readFile(abs, "utf-8");
		expect(content).toMatch(/^(from-1|from-2)$/);
		// Order must be deterministic: write-1 before write-2.
		expect(order).toEqual(["write-1", "write-2"]);

		unmount();
	});

	it("serializes concurrent fs.edit calls on the same path", async () => {
		const { nerve } = makeNerve();
		const organ = createFsOrgan({ cwd: testDir });
		const unmount = organ.mount(nerve.asNerve());

		const filePath = "edit-concurrent.txt";
		await writeFile(join(testDir, filePath), "AAA");

		const collect = (n: number) =>
			new Promise<void>((resolve) => {
				let count = 0;
				const unsub = nerve.asNerve().sense.subscribe("fs.edit", () => {
					count++;
					if (count === n) {
						unsub();
						resolve();
					}
				});
			});

		const done = collect(2);

		nerve.publishMotor({
			type: "fs.edit",
			correlationId: "e1",
			payload: { path: filePath, oldText: "AAA", newText: "BBB" },
		});
		// Second edit must see the result of the first (BBB → CCC), not race on AAA.
		nerve.publishMotor({
			type: "fs.edit",
			correlationId: "e2",
			payload: { path: filePath, oldText: "BBB", newText: "CCC" },
		});

		await done;

		const content = await readFile(join(testDir, filePath), "utf-8");
		expect(content).toBe("CCC");

		unmount();
	});
});

// ---------------------------------------------------------------------------
// Find regressions (ALE-TSK-227, ALE-TSK-228)
// ---------------------------------------------------------------------------

describe("fs.find — path-based glob patterns", () => {
	it("pattern containing / uses --full-path and matches nested files", async () => {
		const { nerve } = makeNerve();
		await mkdir(join(testDir, "src", "auth"), { recursive: true });
		await writeFile(join(testDir, "src", "auth", "login.test.ts"), "");
		await writeFile(join(testDir, "src", "auth", "logout.ts"), "");
		await writeFile(join(testDir, "other.ts"), "");

		const organ = createFsOrgan({ cwd: testDir });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "fs.find");
		nerve.publishMotor({ type: "fs.find", correlationId: "r1", payload: { pattern: "src/**/*.test.ts" } });
		const result = await p;

		const text = (result.payload as { content?: Array<{ text: string }> }).content?.[0]?.text ?? "";
		expect(text).toContain("login.test.ts");
		expect(text).not.toContain("logout.ts");
		expect(text).not.toContain("other.ts");

		unmount();
	});

	it("basename-only pattern still matches without --full-path", async () => {
		const { nerve } = makeNerve();
		await mkdir(join(testDir, "deep", "nested"), { recursive: true });
		await writeFile(join(testDir, "deep", "nested", "target.ts"), "");

		const organ = createFsOrgan({ cwd: testDir });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "fs.find");
		nerve.publishMotor({ type: "fs.find", correlationId: "r2", payload: { pattern: "*.ts" } });
		const result = await p;

		const text = (result.payload as { content?: Array<{ text: string }> }).content?.[0]?.text ?? "";
		expect(text).toContain("target.ts");

		unmount();
	});
});

describe("fs.find — nested gitignore rules", () => {
	it("gitignore in one sibling does not suppress files in another sibling", async () => {
		const { nerve } = makeNerve();

		// sibling-a has a .gitignore that ignores *.log
		await mkdir(join(testDir, "sibling-a"), { recursive: true });
		await writeFile(join(testDir, "sibling-a", ".gitignore"), "*.log\n");
		await writeFile(join(testDir, "sibling-a", "app.ts"), "");

		// sibling-b should not be affected by sibling-a's .gitignore
		await mkdir(join(testDir, "sibling-b"), { recursive: true });
		await writeFile(join(testDir, "sibling-b", "debug.log"), "");
		await writeFile(join(testDir, "sibling-b", "app.ts"), "");

		const organ = createFsOrgan({ cwd: testDir });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "fs.find");
		nerve.publishMotor({ type: "fs.find", correlationId: "r3", payload: { pattern: "*.log" } });
		const result = await p;

		const text = (result.payload as { content?: Array<{ text: string }> }).content?.[0]?.text ?? "";
		// sibling-b/debug.log must appear — not suppressed by sibling-a's gitignore
		expect(text).toContain("debug.log");

		unmount();
	});
});
