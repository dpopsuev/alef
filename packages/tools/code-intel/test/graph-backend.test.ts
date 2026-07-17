/**
 * Graph backend tests.
 */

import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphBackend } from "../src/graph-backend.js";

describe("GraphBackend", { tags: ["unit"] }, () => {
	let backend: GraphBackend;
	let dbPath: string;

	afterEach(() => {
		if (backend) backend.close();
		try {
			if (dbPath) unlinkSync(dbPath);
		} catch {}
	});

	it("indexes symbols and finds them", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "graph-test-"));
		dbPath = join(tmpDir, "test.db");
		backend = new GraphBackend({ dbPath });

		backend.indexFile("test.ts", "hash123", "typescript", [
			{ name: "myFunction", kind: "function", startLine: 1, endLine: 3, startColumn: 0 },
			{ name: "MyClass", kind: "class", startLine: 5, endLine: 10, startColumn: 0 },
		]);

		const results = backend.findSymbols("myFunction");
		expect(results.length).toBe(1);
		expect(results[0]?.symbol.name).toBe("myFunction");
		expect(results[0]?.file).toBe("test.ts");
	});
});
