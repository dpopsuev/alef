/**
 * Performance tests -- indexing throughput and query latency.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphBackend } from "../src/graph-backend.js";
import { WorkspaceIndexer } from "../src/indexer.js";

describe("performance", { tags: ["unit"] }, () => {
	let cwd: string;
	let graph: GraphBackend;
	let indexer: WorkspaceIndexer;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "perf-"));
		graph = new GraphBackend({ dbPath: join(cwd, "graph.db") });
		indexer = new WorkspaceIndexer({ cwd, graph });
	});

	afterEach(() => {
		graph.close();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("indexes 20 TypeScript files under 2 seconds", async () => {
		for (let i = 0; i < 20; i++) {
			writeFileSync(
				join(cwd, `mod${i}.ts`),
				`export function fn${i}(x: number): number {
  if (x > 0) { return x * 2; }
  for (let j = 0; j < x; j++) { console.log(j); }
  return 0;
}

export class C${i} {
  method${i}(val: string): boolean {
    return val.length > 0;
  }
}
`,
			);
		}

		const start = performance.now();
		const result = await indexer.ensureIndexed();
		const elapsed = performance.now() - start;

		expect(result.total).toBe(20);
		expect(result.changed).toBe(20);
		expect(elapsed).toBeLessThan(2000);
	});

	it("queries symbols under 50ms after indexing", async () => {
		for (let i = 0; i < 10; i++) {
			writeFileSync(join(cwd, `lib${i}.ts`), `export function compute${i}(a: number) { return a + ${i}; }\n`);
		}
		await indexer.ensureIndexed();

		const start = performance.now();
		const found = graph.findSymbols("compute");
		const elapsed = performance.now() - start;

		expect(found.length).toBe(10);
		expect(elapsed).toBeLessThan(50);
	});

	it("incremental re-index skips unchanged files efficiently", async () => {
		for (let i = 0; i < 10; i++) {
			writeFileSync(join(cwd, `stable${i}.ts`), `export const val${i} = ${i};\n`);
		}
		await indexer.ensureIndexed();

		writeFileSync(join(cwd, "stable0.ts"), "export const val0 = 999;\nexport function added() {}\n");

		const indexer2 = new WorkspaceIndexer({ cwd, graph });
		const start = performance.now();
		const result = await indexer2.ensureIndexed();
		const elapsed = performance.now() - start;

		expect(result.changed).toBe(1);
		expect(result.total).toBe(10);
		expect(elapsed).toBeLessThan(500);
	});

	it("indexes Python files with complexity metrics", async () => {
		for (let i = 0; i < 5; i++) {
			writeFileSync(
				join(cwd, `py${i}.py`),
				`def process${i}(items, flag):
    for item in items:
        if flag:
            print(item)
    return len(items)

class Handler${i}:
    def handle(self, data):
        return data
`,
			);
		}

		const result = await indexer.ensureIndexed();
		expect(result.total).toBe(5);

		// biome-ignore lint/suspicious/noExplicitAny: test-only DB access
		const db = (graph as any).db;
		const count = db.prepare("SELECT COUNT(*) as n FROM function_complexity").get() as { n: number };
		expect(count.n).toBeGreaterThanOrEqual(10);
	});
});
