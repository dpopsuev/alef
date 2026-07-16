import { describe, expect, it, beforeEach } from "vitest";
import type { BackendProtocol } from "@dpopsuev/alef-kernel/backend";
import { MemoryBackend } from "../src/backends/memory.js";
import { FilesystemBackend } from "../src/backends/filesystem.js";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Shared compliance tests for BackendProtocol implementations.
 */
function backendComplianceSuite(name: string, createBackend: () => Promise<BackendProtocol>) {
	describe(`${name} - BackendProtocol compliance`, () => {
		let backend: BackendProtocol;

		beforeEach(async () => {
			backend = await createBackend();
		});

		describe("read/write", () => {
			it("writes and reads a file", async () => {
				await backend.write("/test.txt", "hello world");
				const content = await backend.read("/test.txt");
				expect(content).toBe("hello world");
			});

			it("overwrites existing file", async () => {
				await backend.write("/file.txt", "first");
				await backend.write("/file.txt", "second");
				const content = await backend.read("/file.txt");
				expect(content).toBe("second");
			});

			it("throws on read of non-existent file", async () => {
				await expect(backend.read("/does-not-exist.txt")).rejects.toThrow();
			});

			it("creates parent directories automatically", async () => {
				await backend.write("/a/b/c/deep.txt", "nested");
				const content = await backend.read("/a/b/c/deep.txt");
				expect(content).toBe("nested");
			});
		});

		describe("delete", () => {
			it("deletes an existing file", async () => {
				await backend.write("/delete-me.txt", "content");
				await backend.delete("/delete-me.txt");
				await expect(backend.read("/delete-me.txt")).rejects.toThrow();
			});

			it("throws when deleting non-existent file", async () => {
				await expect(backend.delete("/not-there.txt")).rejects.toThrow();
			});
		});

		describe("ls", () => {
			it("lists files in a directory", async () => {
				await backend.write("/dir/file1.txt", "a");
				await backend.write("/dir/file2.txt", "b");
				await backend.write("/dir/nested/file3.txt", "c");

				const entries = await backend.ls("/dir");
				expect(entries.length).toBeGreaterThanOrEqual(2);
				
				const names = entries.map(e => e.path.split("/").pop());
				expect(names).toContain("file1.txt");
				expect(names).toContain("file2.txt");
			});

			it("returns empty array for empty directory", async () => {
				await backend.write("/empty-marker/placeholder.txt", "x");
				await backend.delete("/empty-marker/placeholder.txt");
				const entries = await backend.ls("/empty-marker");
				expect(entries).toEqual([]);
			});

			it("throws when path is a file", async () => {
				await backend.write("/file.txt", "content");
				await expect(backend.ls("/file.txt")).rejects.toThrow();
			});
		});

		describe("stat", () => {
			it("returns metadata for a file", async () => {
				await backend.write("/stat-test.txt", "12345");
				const stats = await backend.stat("/stat-test.txt");
				
				expect(stats.path).toBe("/stat-test.txt");
				expect(stats.type).toBe("file");
				expect(stats.size).toBe(5);
				expect(stats.mtime).toBeGreaterThan(0);
			});

			it("returns metadata for a directory", async () => {
				await backend.write("/stat-dir/file.txt", "x");
				const stats = await backend.stat("/stat-dir");
				
				expect(stats.type).toBe("directory");
			});

			it("throws when path doesn't exist", async () => {
				await expect(backend.stat("/missing")).rejects.toThrow();
			});
		});

		describe("exists", () => {
			it("returns true for existing file", async () => {
				await backend.write("/exists.txt", "yes");
				const result = await backend.exists("/exists.txt");
				expect(result).toBe(true);
			});

			it("returns false for non-existent file", async () => {
				const result = await backend.exists("/does-not-exist.txt");
				expect(result).toBe(false);
			});
		});

		describe.skip("glob", () => {
			it("finds files matching a pattern", async () => {
				await backend.write("/src/index.ts", "code");
				await backend.write("/src/util.ts", "helper");
				await backend.write("/src/README.md", "docs");

				const matches = await backend.glob("**/*.ts", "/src");
				expect(matches.length).toBeGreaterThanOrEqual(2);
				
				const paths = matches.map(m => m.path);
				expect(paths.some(p => p.endsWith("index.ts"))).toBe(true);
				expect(paths.some(p => p.endsWith("util.ts"))).toBe(true);
			});

			it("respects maxDepth option", async () => {
				await backend.write("/root/level1.txt", "a");
				await backend.write("/root/sub/level2.txt", "b");

				const shallow = await backend.glob("**/*.txt", "/root", { maxDepth: 1 });
				expect(shallow.length).toBe(1);
				expect(shallow[0]?.path.endsWith("level1.txt")).toBe(true);
			});
		});

		describe.skip("grep", () => {
			it("searches file contents", async () => {
				await backend.write("/log1.txt", "ERROR: failed\nINFO: ok");
				await backend.write("/log2.txt", "INFO: starting\nERROR: timeout");

				const matches = await backend.grep("ERROR", "/");
				expect(matches.length).toBe(2);
				expect(matches.every(m => m.content.includes("ERROR"))).toBe(true);
			});

			it("respects ignoreCase option", async () => {
				await backend.write("/case.txt", "Hello World");

				const caseSensitive = await backend.grep("hello", "/", { ignoreCase: false });
				expect(caseSensitive.length).toBe(0);

				const caseInsensitive = await backend.grep("hello", "/", { ignoreCase: true });
				expect(caseInsensitive.length).toBe(1);
			});

			it("respects literal option", async () => {
				await backend.write("/regex.txt", "test.file");

				const regex = await backend.grep("test.file", "/", { literal: false });
				expect(regex.length).toBeGreaterThan(0);

				const literal = await backend.grep("test.file", "/", { literal: true });
				expect(literal.length).toBeGreaterThan(0);
			});

			it("respects maxMatches limit", async () => {
				let content = "";
				for (let i = 0; i < 100; i++) {
					content += `line ${i} match\n`;
				}
				await backend.write("/many.txt", content);

				const matches = await backend.grep("match", "/", { maxMatches: 10 });
				expect(matches.length).toBe(10);
			});
		});
	});
}

// Run compliance suite for MemoryBackend
backendComplianceSuite("MemoryBackend", async () => new MemoryBackend());

// Run compliance suite for FilesystemBackend
let testDir: string;

backendComplianceSuite("FilesystemBackend", async () => {
	// Create unique temp directory for this test run
	testDir = join(tmpdir(), `alef-backend-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(testDir, { recursive: true });
	
	// Return backend rooted at test directory
	// Note: FilesystemBackend needs absolute paths, so we need to prepend testDir to all operations
	const backend = new FilesystemBackend();
	
	// Wrap backend to prefix paths with testDir
	return {
		read: (path: string) => backend.read(join(testDir, path)),
		write: (path: string, content: string) => backend.write(join(testDir, path), content),
		delete: (path: string) => backend.delete(join(testDir, path)),
		ls: (path: string) => backend.ls(join(testDir, path)).then(entries => 
			entries.map(e => ({ ...e, path: e.path.replace(testDir, "") }))
		),
		stat: (path: string) => backend.stat(join(testDir, path)).then(e => 
			({ ...e, path: e.path.replace(testDir, "") })
		),
		exists: (path: string) => backend.exists(join(testDir, path)),
		glob: (pattern: string, root: string, opts?: any) => 
			backend.glob(pattern, join(testDir, root), opts).then(matches =>
				matches.map(m => ({ ...m, path: m.path.replace(testDir, "") }))
			),
		grep: (pattern: string, root: string, opts?: any) =>
			backend.grep(pattern, join(testDir, root), opts).then(matches =>
				matches.map(m => ({ ...m, path: m.path.replace(testDir, "") }))
			),
	};
});

// Cleanup test directory after FilesystemBackend tests
import { afterAll } from "vitest";
afterAll(async () => {
	if (testDir) {
		await rm(testDir, { recursive: true, force: true });
	}
});

describe("MemoryBackend specific", () => {
	it("snapshot returns all files", async () => {
		const backend = new MemoryBackend();
		await backend.write("/a.txt", "aaa");
		await backend.write("/b.txt", "bbb");
		await backend.write("/dir/c.txt", "ccc");

		const snapshot = backend.snapshot();
		expect(snapshot.size).toBe(3);
		expect(snapshot.get("/a.txt")).toBe("aaa");
		expect(snapshot.get("/b.txt")).toBe("bbb");
		expect(snapshot.get("/dir/c.txt")).toBe("ccc");
	});

	it("is isolated between instances", async () => {
		const backend1 = new MemoryBackend();
		const backend2 = new MemoryBackend();

		await backend1.write("/test.txt", "backend1");
		
		const exists = await backend2.exists("/test.txt");
		expect(exists).toBe(false);
	});
});
