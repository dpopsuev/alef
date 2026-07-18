/**
 * Integration tests for Python call/reference extraction, function_complexity, and dataflow.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphBackend } from "../src/graph-backend.js";
import { WorkspaceIndexer } from "../src/indexer.js";

describe("integration", { tags: ["unit"] }, () => {
	let cwd: string;
	let graph: GraphBackend;
	let indexer: WorkspaceIndexer;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "code-intel-integration-"));
		graph = new GraphBackend({ dbPath: join(cwd, "graph.db") });
		indexer = new WorkspaceIndexer({ cwd, graph });
	});

	afterEach(() => {
		graph.close();
		rmSync(cwd, { recursive: true, force: true });
	});

	describe("Python extractCalls", () => {
		it("extracts simple function calls", async () => {
			writeFileSync(
				join(cwd, "app.py"),
				`def greet(name):
    print(name)

def main():
    greet("world")
    print("done")

main()
`,
			);
			await indexer.ensureIndexed();

			const impact = graph.getImpact("app.py");
			const greetSymbol = impact.affectedSymbols.find((s) => s.symbol === "greet");
			expect(greetSymbol).toBeDefined();
			expect(greetSymbol!.callers).toBeGreaterThanOrEqual(1);
		});

		it("extracts method calls via attribute access", async () => {
			writeFileSync(
				join(cwd, "methods.py"),
				`class Formatter:
    def format(self, text):
        return text.upper()

def run():
    f = Formatter()
    f.format("hello")
`,
			);
			await indexer.ensureIndexed();

			const impact = graph.getImpact("methods.py");
			const formatSymbol = impact.affectedSymbols.find((s) => s.symbol === "format");
			expect(formatSymbol).toBeDefined();
			expect(formatSymbol!.callers).toBeGreaterThanOrEqual(1);
		});

		it("extracts calls within nested functions", async () => {
			writeFileSync(
				join(cwd, "nested.py"),
				`def outer():
    def inner():
        return 1
    inner()
`,
			);
			await indexer.ensureIndexed();

			const impact = graph.getImpact("nested.py");
			const innerSymbol = impact.affectedSymbols.find((s) => s.symbol === "inner");
			expect(innerSymbol).toBeDefined();
			expect(innerSymbol!.callers).toBeGreaterThanOrEqual(1);
		});
	});

	describe("Python extractReferences", () => {
		it("extracts identifier references for file-local symbols", async () => {
			writeFileSync(
				join(cwd, "refs.py"),
				`def helper():
    return 42

def main():
    x = helper()
    print(x)
`,
			);
			await indexer.ensureIndexed();

			const refs = graph.getReferences("helper", "refs.py");
			expect(refs.length).toBeGreaterThanOrEqual(2);
			const callRef = refs.find((r) => r.type === "call");
			expect(callRef).toBeDefined();
		});

		it("classifies call references correctly", async () => {
			writeFileSync(
				join(cwd, "classify.py"),
				`def process(data):
    return data

def run():
    result = process([1, 2, 3])
`,
			);
			await indexer.ensureIndexed();

			const refs = graph.getReferences("process", "classify.py");
			const callRefs = refs.filter((r) => r.type === "call");
			expect(callRefs.length).toBeGreaterThanOrEqual(1);
		});

		it("finds read references", async () => {
			writeFileSync(
				join(cwd, "reads.py"),
				`def transformer():
    pass

handler = transformer
`,
			);
			await indexer.ensureIndexed();

			const refs = graph.getReferences("transformer", "reads.py");
			const readRefs = refs.filter((r) => r.type === "read");
			expect(readRefs.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("function_complexity", () => {
		function queryComplexity(g: GraphBackend, symbolName: string) {
			// biome-ignore lint/suspicious/noExplicitAny: test-only DB access
			const db = (g as any).db;
			return db
				.prepare(
					`SELECT fc.* FROM function_complexity fc
					 JOIN symbols s ON s.id = fc.symbol_id
					 WHERE s.name = ?`,
				)
				.get(symbolName) as
				| { cyclomatic: number; cognitive: number; parameters: number; lines_of_code: number; max_nesting: number }
				| undefined;
		}

		it("populates complexity for TypeScript functions", async () => {
			writeFileSync(
				join(cwd, "complex.ts"),
				`export function decide(x: number, y: number): string {
  if (x > 0) {
    if (y > 0) {
      return "both positive";
    }
    return "x positive";
  }
  for (let i = 0; i < x; i++) {
    console.log(i);
  }
  return "done";
}
`,
			);
			await indexer.ensureIndexed();

			const cm = queryComplexity(graph, "decide");
			expect(cm).toBeDefined();
			expect(cm!.cyclomatic).toBeGreaterThanOrEqual(3);
			expect(cm!.parameters).toBe(2);
			expect(cm!.lines_of_code).toBeGreaterThanOrEqual(10);
			expect(cm!.max_nesting).toBeGreaterThanOrEqual(1);
		});

		it("populates complexity for Python functions", async () => {
			writeFileSync(
				join(cwd, "complex.py"),
				`def process(items, flag):
    for item in items:
        if flag:
            print(item)
        else:
            pass
    return len(items)
`,
			);
			await indexer.ensureIndexed();

			const cm = queryComplexity(graph, "process");
			expect(cm).toBeDefined();
			expect(cm!.cyclomatic).toBeGreaterThanOrEqual(3);
			expect(cm!.parameters).toBe(2);
			expect(cm!.lines_of_code).toBeGreaterThanOrEqual(5);
		});

		it("counts parameters excluding self for Python methods", async () => {
			writeFileSync(
				join(cwd, "method.py"),
				`class Foo:
    def bar(self, x, y, z):
        return x + y + z
`,
			);
			await indexer.ensureIndexed();

			const cm = queryComplexity(graph, "bar");
			expect(cm).toBeDefined();
			expect(cm!.parameters).toBe(3);
		});
	});

	describe("dataflow", () => {
		function queryDataflow(g: GraphBackend, fromSymbol: string, toSymbol: string) {
			// biome-ignore lint/suspicious/noExplicitAny: test-only DB access
			const db = (g as any).db;
			return db
				.prepare(
					`SELECT df.flow_type, df.variable_name, df.line FROM dataflow df
					 JOIN symbols sf ON sf.id = df.from_symbol_id
					 JOIN symbols st ON st.id = df.to_symbol_id
					 WHERE sf.name = ? AND st.name = ?`,
				)
				.all(fromSymbol, toSymbol) as Array<{ flow_type: string; variable_name: string | null; line: number }>;
		}

		it("records parameter passing edges in JS/TS", async () => {
			writeFileSync(
				join(cwd, "flow.ts"),
				`function transform(data: string): string {
  return data.toUpperCase();
}

function process(input: string): void {
  const result = transform(input);
  console.log(result);
}
`,
			);
			await indexer.ensureIndexed();

			const edges = queryDataflow(graph, "process", "transform");
			expect(edges.length).toBeGreaterThanOrEqual(1);
			const paramEdge = edges.find((e) => e.flow_type === "parameter");
			expect(paramEdge).toBeDefined();
		});

		it("records return value flows in JS/TS", async () => {
			writeFileSync(
				join(cwd, "retflow.ts"),
				`function compute(x: number): number {
  return x * 2;
}

function wrapper(): number {
  return compute(42);
}
`,
			);
			await indexer.ensureIndexed();

			const edges = queryDataflow(graph, "compute", "wrapper");
			expect(edges.length).toBeGreaterThanOrEqual(1);
			const returnEdge = edges.find((e) => e.flow_type === "return");
			expect(returnEdge).toBeDefined();
		});
	});
});
