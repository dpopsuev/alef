/**
 * Enhanced callers tests -- graph-backed call detection across JS/TS/Python.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphBackend } from "../src/graph-backend.js";
import { WorkspaceIndexer } from "../src/indexer.js";

describe("callers-enhanced", { tags: ["unit"] }, () => {
	let cwd: string;
	let graph: GraphBackend;
	let indexer: WorkspaceIndexer;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "callers-enhanced-"));
		graph = new GraphBackend({ dbPath: join(cwd, "graph.db") });
		indexer = new WorkspaceIndexer({ cwd, graph });
	});

	afterEach(() => {
		graph.close();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("finds cross-file dependents and same-file callers via impact", async () => {
		writeFileSync(
			join(cwd, "lib.ts"),
			`export function validate(x: string): boolean { return x.length > 0; }
export function check(y: string): boolean { return validate(y); }
`,
		);
		writeFileSync(
			join(cwd, "app.ts"),
			'import { validate } from "./lib.js";\nexport const ok = validate("test");\n',
		);
		await indexer.ensureIndexed();

		const impact = graph.getImpact("lib.ts");
		expect(impact.dependents).toContain("app.ts");
		const sym = impact.affectedSymbols.find((s) => s.symbol === "validate");
		expect(sym).toBeDefined();
		expect(sym!.callers).toBeGreaterThanOrEqual(1);
	});

	it("detects Python cross-function callers within a single file", async () => {
		writeFileSync(
			join(cwd, "service.py"),
			`def fetch_data(url):
    return url

def process():
    data = fetch_data("https://example.com")
    return data
`,
		);
		await indexer.ensureIndexed();

		const impact = graph.getImpact("service.py");
		const fetchSym = impact.affectedSymbols.find((s) => s.symbol === "fetch_data");
		expect(fetchSym).toBeDefined();
		expect(fetchSym!.callers).toBeGreaterThanOrEqual(1);
	});

	it("counts multiple callers of the same function", async () => {
		writeFileSync(
			join(cwd, "util.ts"),
			`export function log(msg: string): void { console.log(msg); }
export function a() { log("a"); }
export function b() { log("b"); }
export function c() { log("c"); }
`,
		);
		await indexer.ensureIndexed();

		const impact = graph.getImpact("util.ts");
		const logSym = impact.affectedSymbols.find((s) => s.symbol === "log");
		expect(logSym).toBeDefined();
		expect(logSym!.callers).toBeGreaterThanOrEqual(3);
	});

	it("finds references of a symbol across the graph", async () => {
		writeFileSync(
			join(cwd, "math.ts"),
			`export function add(a: number, b: number): number { return a + b; }
export function sum(items: number[]): number {
  let result = 0;
  for (const item of items) { result = add(result, item); }
  return result;
}
`,
		);
		await indexer.ensureIndexed();

		const refs = graph.getReferences("add", "math.ts");
		expect(refs.length).toBeGreaterThanOrEqual(2);
		const callRefs = refs.filter((r) => r.type === "call");
		expect(callRefs.length).toBeGreaterThanOrEqual(1);
	});

	it("handles Python method calls via attribute access", async () => {
		writeFileSync(
			join(cwd, "cls.py"),
			`class Engine:
    def start(self):
        return True

    def run(self):
        self.start()
        return "running"
`,
		);
		await indexer.ensureIndexed();

		const impact = graph.getImpact("cls.py");
		const startSym = impact.affectedSymbols.find((s) => s.symbol === "start");
		expect(startSym).toBeDefined();
		expect(startSym!.callers).toBeGreaterThanOrEqual(1);
	});
});
