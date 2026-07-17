/**
 * Tests for incremental indexing and change detection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphBackend } from "../src/graph-backend.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Incremental Indexing", () => {
	let tempDir: string;
	let dbPath: string;
	let backend: GraphBackend;

	beforeEach(() => {
		// Create temp directory for test files
		tempDir = mkdtempSync(join(tmpdir(), "code-intel-test-"));
		dbPath = join(tempDir, "test.db");
		backend = new GraphBackend({ dbPath });
	});

	afterEach(() => {
		backend.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should detect new files as changed", () => {
		const testFile = join(tempDir, "test.ts");
		writeFileSync(testFile, "export function foo() {}");

		const changed = backend.detectChangedFiles([testFile]);
		expect(changed).toContain(testFile);
		expect(changed).toHaveLength(1);
	});

	it("should skip unchanged files after indexing", () => {
		const testFile = join(tempDir, "test.ts");
		const content = "export function foo() {}";
		writeFileSync(testFile, content);

		// First index
		backend.indexFile(testFile, "hash1", "typescript", [
			{ name: "foo", kind: "function", startLine: 1, endLine: 1, startColumn: 0 },
		]);

		// Second check - file unchanged
		const changed = backend.detectChangedFiles([testFile]);
		expect(changed).toHaveLength(0);
	});

	it("should detect changed files after modification", () => {
		const testFile = join(tempDir, "test.ts");
		writeFileSync(testFile, "export function foo() {}");

		// Initial index
		backend.indexFile(testFile, "hash1", "typescript", [
			{ name: "foo", kind: "function", startLine: 1, endLine: 1, startColumn: 0 },
		]);

		// Modify file (different size so coarse mtime clocks still detect change)
		writeFileSync(testFile, "export function barChanged() { return 1; }\n");

		// Should detect change
		const changed = backend.detectChangedFiles([testFile]);
		expect(changed).toContain(testFile);
		expect(changed).toHaveLength(1);
	});

	it("should scan workspace and find changed files", () => {
		// Create multiple files
		const file1 = join(tempDir, "file1.ts");
		const file2 = join(tempDir, "file2.ts");
		const file3 = join(tempDir, "file3.js");

		writeFileSync(file1, "export const a = 1;");
		writeFileSync(file2, "export const b = 2;");
		writeFileSync(file3, "export const c = 3;");

		// Initial scan - all files new
		const changedFirst = backend.scanWorkspace(tempDir);
		expect(changedFirst).toHaveLength(3);

		// Index file1 and file2
		backend.indexFile(file1, "hash1", "typescript", []);
		backend.indexFile(file2, "hash2", "typescript", []);

		// Second scan - only file3 changed (not indexed yet)
		const changedSecond = backend.scanWorkspace(tempDir);
		expect(changedSecond).toContain(file3);
		expect(changedSecond).not.toContain(file1);
		expect(changedSecond).not.toContain(file2);
		expect(changedSecond).toHaveLength(1);
	});

	it("should correctly report incremental update statistics", () => {
		// Create files
		const file1 = join(tempDir, "file1.ts");
		const file2 = join(tempDir, "file2.ts");
		writeFileSync(file1, "export const a = 1;");
		writeFileSync(file2, "export const b = 2;");

		// Index file1 only
		backend.indexFile(file1, "hash1", "typescript", []);

		// Incremental update should find file2 as changed
		let indexedFiles: string[] = [];
		const stats = backend.incrementalUpdate(tempDir, (file) => {
			indexedFiles.push(file);
		});

		expect(stats.changedCount).toBe(1);
		expect(stats.totalCount).toBe(2);
		expect(indexedFiles).toContain(file2);
		expect(indexedFiles).not.toContain(file1);
	});
});
