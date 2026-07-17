/**
 * Impact analysis against GraphBackend + WorkspaceIndexer.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphBackend } from "../src/graph-backend.js";
import { WorkspaceIndexer } from "../src/indexer.js";

describe("impact", { tags: ["unit"] }, () => {
	let cwd: string;
	let graph: GraphBackend;
	let indexer: WorkspaceIndexer;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "code-intel-impact-"));
		graph = new GraphBackend({ dbPath: join(cwd, "graph.db") });
		indexer = new WorkspaceIndexer({ cwd, graph });
		writeFileSync(join(cwd, "lib.ts"), "export function core() { return 1; }\n");
		writeFileSync(join(cwd, "app.ts"), 'import { core } from "./lib.js";\nexport const x = core();\n');
	});

	afterEach(() => {
		graph.close();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("lists importers as dependents", async () => {
		await indexer.ensureIndexed();
		const impact = graph.getImpact("lib.ts");
		expect(impact.dependents).toContain("app.ts");
	});
});
