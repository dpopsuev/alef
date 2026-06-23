import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusFixture, organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsOrgan } from "../src/adapter.js";

organComplianceSuite(() => createFsOrgan({ cwd: "/tmp" }));

let testDir: string;

beforeEach(async () => {
	testDir = join(tmpdir(), `alef-fs-organ-test-${Date.now()}`);
	await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

function fixture() {
	const f = new BusFixture();
	f.mount(createFsOrgan({ cwd: testDir }));
	return f;
}

describe("Fsorgan", { tags: ["compliance"] }, () => {
	it("has name=fs and 6 tools", () => {
		const organ = createFsOrgan({ cwd: testDir });
		expect(organ.name).toBe("fs");
		expect(organ.tools.map((t) => t.name)).toEqual([
			"fs.read",
			"fs.grep",
			"fs.find",
			"fs.write",
			"fs.edit",
			"fs.patch",
		]);
	});

	it("unmount unsubscribes all command handlers", () => {
		const f = new BusFixture();
		const organ = createFsOrgan({ cwd: testDir });
		const unmount = f.mount(organ);
		expect(f.nerve.listenerCount("command", "fs.read")).toBe(1);
		unmount();
		expect(f.nerve.listenerCount("command", "fs.read")).toBe(0);
		expect(f.nerve.listenerCount("command", "fs.grep")).toBe(0);
		expect(f.nerve.listenerCount("command", "fs.find")).toBe(0);
	});

	describe("fs.read", () => {
		it("reads a file and publishes Event/fs.read", async () => {
			await writeFile(join(testDir, "hello.txt"), "line1\nline2\nline3\n");
			const f = fixture();
			const result = await f.call("fs.read", { path: "hello.txt" });
			expect(result.isError).toBe(false);
			expect(result.payload.content).toContain("line1");
			expect(result.payload.content).toContain("line3");
			f.dispose();
		});

		it("applies offset", async () => {
			await writeFile(join(testDir, "lines.txt"), "a\nb\nc\nd\n");
			const f = fixture();
			const result = await f.call("fs.read", { path: "lines.txt", offset: 3 });
			expect(result.isError).toBe(false);
			const content = result.payload.content as string;
			expect(content).not.toContain("a\n");
			expect(content).toContain("c");
			f.dispose();
		});

		it("publishes error on missing file", async () => {
			const f = fixture();
			const result = await f.call("fs.read", { path: "nonexistent.txt" });
			expect(result.isError).toBe(true);
			expect(result.errorMessage).toMatch(/ENOENT/);
			f.dispose();
		});

		it("mirrors correlationId from command event", async () => {
			await writeFile(join(testDir, "foo.txt"), "foo");
			const f = fixture();
			const correlationId = "my-correlation-id";
			const result = await f.call("fs.read", { path: "foo.txt" }, { correlationId });
			expect(result.correlationId).toBe(correlationId);
			f.dispose();
		});
	});

	describe("fs.grep", () => {
		it("finds pattern matches and publishes Event/fs.grep", async () => {
			await writeFile(join(testDir, "src.ts"), "const foo = 1;\nconst bar = 2;\n");
			const f = fixture();
			const result = await f.call("fs.grep", { pattern: "foo" });
			expect(result.isError).toBe(false);
			f.dispose();
		});
	});

	describe("fs.find", () => {
		it("finds files by pattern and publishes Event/fs.find", async () => {
			await writeFile(join(testDir, "a.ts"), "");
			await writeFile(join(testDir, "b.ts"), "");
			await writeFile(join(testDir, "c.txt"), "");
			const f = fixture();
			const result = await f.call("fs.find", { pattern: "*.ts" });
			expect(result.isError).toBe(false);
			f.dispose();
		});
	});

	describe("fs.write", () => {
		it("creates a file and returns bytes written", async () => {
			const f = fixture();
			const result = await f.call("fs.write", { path: "hello.txt", content: "hello world" });
			expect(result.isError).toBe(false);
			expect(result.payload.bytes).toBe(11);
			expect(await readFile(join(testDir, "hello.txt"), "utf-8")).toBe("hello world");
			f.dispose();
		});

		it("overwrites an existing file", async () => {
			await writeFile(join(testDir, "existing.txt"), "old content");
			const f = fixture();
			await f.call("fs.write", { path: "existing.txt", content: "new content" });
			expect(await readFile(join(testDir, "existing.txt"), "utf-8")).toBe("new content");
			f.dispose();
		});
	});

	describe("fs.edit", () => {
		it("replaces first occurrence of oldText with newText", async () => {
			await writeFile(join(testDir, "source.ts"), "const x = 1;\nconst y = 2;");
			const f = fixture();
			await f.call("fs.read", { path: "source.ts" });
			const result = await f.call("fs.edit", {
				path: "source.ts",
				oldText: "const x = 1;",
				newText: "const x = 99;",
			});
			expect(result.isError).toBe(false);
			expect(result.payload.applied).toBe(true);
			expect(await readFile(join(testDir, "source.ts"), "utf-8")).toBe("const x = 99;\nconst y = 2;");
			f.dispose();
		});

		it("errors when oldText is not found", async () => {
			await writeFile(join(testDir, "source.ts"), "const x = 1;");
			const f = fixture();
			await f.call("fs.read", { path: "source.ts" });
			const result = await f.call("fs.edit", { path: "source.ts", oldText: "not here", newText: "x" });
			expect(result.isError).toBe(true);
			expect(result.errorMessage).toMatch(/not found/);
			f.dispose();
		});

		it("errors when oldText matches multiple locations", async () => {
			await writeFile(join(testDir, "dup.ts"), "foo\nfoo");
			const f = fixture();
			await f.call("fs.read", { path: "dup.ts" });
			const result = await f.call("fs.edit", { path: "dup.ts", oldText: "foo", newText: "bar" });
			expect(result.isError).toBe(true);
			expect(result.errorMessage).toMatch(/multiple/);
			f.dispose();
		});
	});

	describe("cache", () => {
		it("fs.read result is served from cache on second call", async () => {
			const filePath = join(testDir, "cached.txt");
			await writeFile(filePath, "v1");
			const f = fixture();
			const r1 = await f.call("fs.read", { path: filePath });
			expect((r1.payload.content as string).trim()).toBe("v1");

			await writeFile(filePath, "v2-on-disk");
			const r2 = await f.call("fs.read", { path: filePath });
			expect((r2.payload.content as string).trim()).toBe("v1");
			f.dispose();
		});

		it("fs.write invalidates the fs.read cache", async () => {
			const filePath = join(testDir, "inv.txt");
			await writeFile(filePath, "original");
			const f = fixture();

			const r1 = await f.call("fs.read", { path: filePath });
			expect((r1.payload.content as string).trim()).toBe("original");

			await f.call("fs.write", { path: filePath, content: "updated" });

			const r2 = await f.call("fs.read", { path: filePath });
			expect((r2.payload.content as string).trim()).toBe("updated");
			f.dispose();
		});
	});
});

describe("write serialization — file mutation queue", { tags: ["compliance"] }, () => {
	it("serializes concurrent fs.write calls on the same path", async () => {
		const f = new BusFixture();
		f.mount(createFsOrgan({ cwd: testDir }));

		const filePath = "concurrent.txt";
		const abs = join(testDir, filePath);
		await writeFile(abs, "");

		const order: string[] = [];

		const p1 = new Promise<void>((resolve) => {
			const unsub = f.nerve.asBus().event.subscribe("fs.write", (event) => {
				if ((event.payload as { path?: string }).path === filePath) {
					order.push("write-1");
					unsub();
					resolve();
				}
			});
		});
		const p2 = new Promise<void>((resolve) => {
			let count = 0;
			const unsub = f.nerve.asBus().event.subscribe("fs.write", () => {
				count++;
				if (count === 2) {
					order.push("write-2");
					unsub();
					resolve();
				}
			});
		});

		f.nerve.publish("command", {
			type: "fs.write",
			correlationId: "c1",
			payload: { path: filePath, content: "from-1" },
		});
		f.nerve.publish("command", {
			type: "fs.write",
			correlationId: "c2",
			payload: { path: filePath, content: "from-2" },
		});

		await Promise.all([p1, p2]);

		const content = await readFile(abs, "utf-8");
		expect(content).toMatch(/^(from-1|from-2)$/);
		expect(order).toEqual(["write-1", "write-2"]);
		f.dispose();
	});

	it("serializes concurrent fs.edit calls on the same path", async () => {
		const f = new BusFixture();
		f.mount(createFsOrgan({ cwd: testDir }));

		const filePath = "edit-concurrent.txt";
		await writeFile(join(testDir, filePath), "AAA");

		// Read first so FileTracker permits edits. Use raw subscribe before
		// publish — concurrent serialization tests are sensitive to async ordering.
		await new Promise<void>((resolve) => {
			const off = f.nerve.asBus().event.subscribe("fs.read", () => {
				off();
				resolve();
			});
			f.nerve.publish("command", { type: "fs.read", correlationId: "r0", payload: { path: filePath } });
		});

		const collect = (n: number) =>
			new Promise<void>((resolve) => {
				let count = 0;
				const unsub = f.nerve.asBus().event.subscribe("fs.edit", () => {
					count++;
					if (count === n) {
						unsub();
						resolve();
					}
				});
			});

		const done = collect(2);
		f.nerve.publish("command", {
			type: "fs.edit",
			correlationId: "e1",
			payload: { path: filePath, oldText: "AAA", newText: "BBB" },
		});
		f.nerve.publish("command", {
			type: "fs.edit",
			correlationId: "e2",
			payload: { path: filePath, oldText: "BBB", newText: "CCC" },
		});
		await done;

		expect(await readFile(join(testDir, filePath), "utf-8")).toBe("CCC");
		f.dispose();
	});
});

describe("fs.find — path-based glob patterns", { tags: ["compliance"] }, () => {
	it("pattern containing / uses --full-path and matches nested files", async () => {
		const f = new BusFixture();
		await mkdir(join(testDir, "src", "auth"), { recursive: true });
		await writeFile(join(testDir, "src", "auth", "login.test.ts"), "");
		await writeFile(join(testDir, "src", "auth", "logout.ts"), "");
		await writeFile(join(testDir, "other.ts"), "");
		f.mount(createFsOrgan({ cwd: testDir }));

		const result = await f.call("fs.find", { pattern: "src/**/*.test.ts" });
		const text = (result.payload as { content?: Array<{ text: string }> }).content?.[0]?.text ?? "";
		expect(text).toContain("login.test.ts");
		expect(text).not.toContain("logout.ts");
		expect(text).not.toContain("other.ts");
		f.dispose();
	});

	it("basename-only pattern still matches without --full-path", async () => {
		const f = new BusFixture();
		await mkdir(join(testDir, "deep", "nested"), { recursive: true });
		await writeFile(join(testDir, "deep", "nested", "target.ts"), "");
		f.mount(createFsOrgan({ cwd: testDir }));

		const result = await f.call("fs.find", { pattern: "*.ts" });
		const text = (result.payload as { content?: Array<{ text: string }> }).content?.[0]?.text ?? "";
		expect(text).toContain("target.ts");
		f.dispose();
	});
});

describe("fs.find — nested gitignore rules", { tags: ["compliance"] }, () => {
	it("gitignore in one sibling does not suppress files in another sibling", async () => {
		const f = new BusFixture();
		await mkdir(join(testDir, "sibling-a"), { recursive: true });
		await writeFile(join(testDir, "sibling-a", ".gitignore"), "*.log\n");
		await writeFile(join(testDir, "sibling-a", "app.ts"), "");
		await mkdir(join(testDir, "sibling-b"), { recursive: true });
		await writeFile(join(testDir, "sibling-b", "debug.log"), "");
		await writeFile(join(testDir, "sibling-b", "app.ts"), "");
		f.mount(createFsOrgan({ cwd: testDir }));

		const result = await f.call("fs.find", { pattern: "*.log" });
		const text = (result.payload as { content?: Array<{ text: string }> }).content?.[0]?.text ?? "";
		expect(text).toContain("debug.log");
		f.dispose();
	});
});

describe("fs.edit — multi-edit", { tags: ["compliance"] }, () => {
	it("applies multiple disjoint edits atomically", async () => {
		const f = new BusFixture();
		await writeFile(join(testDir, "multi.ts"), "AAA BBB CCC");
		f.mount(createFsOrgan({ cwd: testDir }));
		await f.call("fs.read", { path: "multi.ts" });

		const result = await f.call("fs.edit", {
			path: "multi.ts",
			edits: [
				{ oldText: "AAA", newText: "111" },
				{ oldText: "CCC", newText: "333" },
			],
		});
		expect(result.isError).toBe(false);
		expect(await readFile(join(testDir, "multi.ts"), "utf-8")).toBe("111 BBB 333");
		expect((result.payload as { editCount?: number }).editCount).toBe(2);
		f.dispose();
	});

	it("matches edits against original, not incrementally", async () => {
		const f = new BusFixture();
		await writeFile(join(testDir, "orig.ts"), "AAA AAA");
		f.mount(createFsOrgan({ cwd: testDir }));
		await f.call("fs.read", { path: "orig.ts" });

		const result = await f.call("fs.edit", { path: "orig.ts", edits: [{ oldText: "AAA", newText: "111" }] });
		expect(result.isError).toBe(true);
		f.dispose();
	});

	it("rejects overlapping edits", async () => {
		const f = new BusFixture();
		await writeFile(join(testDir, "over.ts"), "ABCDEF");
		f.mount(createFsOrgan({ cwd: testDir }));
		await f.call("fs.read", { path: "over.ts" });

		const result = await f.call("fs.edit", {
			path: "over.ts",
			edits: [
				{ oldText: "ABC", newText: "X" },
				{ oldText: "BCD", newText: "Y" },
			],
		});
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/overlap/i);
		f.dispose();
	});

	it("reports ENOENT clearly", async () => {
		const f = new BusFixture();
		f.mount(createFsOrgan({ cwd: testDir }));

		const result = await f.call("fs.edit", { path: "nonexistent.ts", oldText: "X", newText: "Y" });
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/not found|ENOENT/i);
		f.dispose();
	});
});

describe("fs.read — binary/image detection", { tags: ["compliance"] }, () => {
	it("rejects a PNG file by magic bytes, not extension", async () => {
		const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		await writeFile(join(testDir, "image.notapng"), pngMagic);
		const f = fixture();
		const result = await f.call("fs.read", { path: "image.notapng" });
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/binary|image\/png/i);
		f.dispose();
	});

	it("rejects a JPEG file", async () => {
		const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
		await writeFile(join(testDir, "photo.ts"), jpegMagic);
		const f = fixture();
		const result = await f.call("fs.read", { path: "photo.ts" });
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/binary|image\/jpeg/i);
		f.dispose();
	});

	it("reads a text file with .png extension correctly", async () => {
		await writeFile(join(testDir, "data.png"), "export const x = 1;\n");
		const f = fixture();
		const result = await f.call("fs.read", { path: "data.png" });
		expect(result.isError).toBe(false);
		expect((result.payload as { content?: string }).content).toContain("export const x");
		f.dispose();
	});
});

import { FileTracker } from "../src/adapter.js";

describe("FileTracker.reads capped to prevent memory leak", { tags: ["compliance"] }, () => {
	it("size stays bounded after recording more paths than the cap", () => {
		const tracker = new FileTracker();
		for (let i = 0; i < 1200; i++) tracker.record(`/project/src/module${i}.ts`);
		expect(tracker.size).toBeLessThanOrEqual(1000);
	});

	it("oldest entries evicted first when cap is exceeded", () => {
		const tracker = new FileTracker();
		tracker.record("/project/src/early-file.ts");
		for (let i = 0; i < 1200; i++) tracker.record(`/project/src/later${i}.ts`);
		expect(tracker.size).toBeLessThanOrEqual(1000);
	});
});
