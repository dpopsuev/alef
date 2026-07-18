/**
 * File watcher / change detection tests -- three-tier detection and re-index.
 */
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphBackend } from "../src/graph-backend.js";
import { WorkspaceIndexer } from "../src/indexer.js";

describe("file-watcher", { tags: ["unit"] }, () => {
	let cwd: string;
	let graph: GraphBackend;
	let indexer: WorkspaceIndexer;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "file-watcher-"));
		graph = new GraphBackend({ dbPath: join(cwd, "graph.db") });
		indexer = new WorkspaceIndexer({ cwd, graph });
	});

	afterEach(() => {
		graph.close();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("detects new files on first index", async () => {
		writeFileSync(join(cwd, "a.ts"), "export const x = 1;\n");
		const result = await indexer.ensureIndexed();
		expect(result.changed).toBe(1);
		expect(result.total).toBe(1);
	});

	it("skips unchanged files on second index", async () => {
		writeFileSync(join(cwd, "a.ts"), "export const x = 1;\n");
		await indexer.ensureIndexed();

		const indexer2 = new WorkspaceIndexer({ cwd, graph });
		const result = await indexer2.ensureIndexed();
		expect(result.changed).toBe(0);
		expect(result.total).toBe(1);
	});

	it("detects modified file content", async () => {
		const filePath = join(cwd, "a.ts");
		writeFileSync(filePath, "export const x = 1;\n");
		await indexer.ensureIndexed();

		writeFileSync(filePath, "export const x = 2;\nexport function foo() {}\n");

		const indexer2 = new WorkspaceIndexer({ cwd, graph });
		const result = await indexer2.ensureIndexed();
		expect(result.changed).toBe(1);

		const symbols = graph.findSymbols("foo");
		expect(symbols.length).toBe(1);
	});

	it("detects added files in subsequent indexing", async () => {
		writeFileSync(join(cwd, "a.ts"), "export const x = 1;\n");
		await indexer.ensureIndexed();

		writeFileSync(join(cwd, "b.ts"), "export function bar() {}\n");

		const indexer2 = new WorkspaceIndexer({ cwd, graph });
		const result = await indexer2.ensureIndexed();
		expect(result.changed).toBe(1);
		expect(result.total).toBe(2);
	});

	it("handles mtime-only changes with same content (no false re-index)", async () => {
		const filePath = join(cwd, "a.ts");
		const content = "export const stable = true;\n";
		writeFileSync(filePath, content);
		await indexer.ensureIndexed();

		const now = new Date();
		utimesSync(filePath, now, now);

		const changed = graph.detectChangedFiles([filePath]);
		expect(changed.length).toBe(0);
	});
});
