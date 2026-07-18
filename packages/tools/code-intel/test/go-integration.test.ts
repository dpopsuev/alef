/**
 * Go end-to-end integration test -- CodeGraph extractor via vendored path.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphBackend } from "../src/graph-backend.js";
import { WorkspaceIndexer } from "../src/indexer.js";

describe("Go integration", { tags: ["unit"] }, () => {
	let cwd: string;
	let graph: GraphBackend;
	let indexer: WorkspaceIndexer;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "go-integration-"));
		graph = new GraphBackend({ dbPath: join(cwd, "graph.db") });
		indexer = new WorkspaceIndexer({ cwd, graph });
	});

	afterEach(() => {
		graph.close();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("indexes Go symbols into the graph", async () => {
		writeFileSync(
			join(cwd, "main.go"),
			`package main

import "fmt"

func greet(name string) string {
	return "Hello, " + name
}

func main() {
	fmt.Println(greet("world"))
}
`,
		);
		await indexer.ensureIndexed();

		const symbols = graph.findSymbols("greet");
		expect(symbols.length).toBeGreaterThanOrEqual(1);
		expect(symbols[0]!.symbol.kind).toBe("function");
	});

	it("extracts Go imports", async () => {
		writeFileSync(
			join(cwd, "server.go"),
			`package main

import (
	"fmt"
	"net/http"
)

func handler(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "Hello")
}
`,
		);
		await indexer.ensureIndexed();

		const deps = graph.getDependencies("server.go");
		expect(deps.length).toBeGreaterThanOrEqual(1);
		const fmtDep = deps.find((d) => d.import === "fmt");
		expect(fmtDep).toBeDefined();
	});

	it("extracts Go call edges and reports impact", async () => {
		writeFileSync(
			join(cwd, "lib.go"),
			`package main

func compute(x int) int {
	return x * 2
}

func process() int {
	return compute(21)
}
`,
		);
		await indexer.ensureIndexed();

		const impact = graph.getImpact("lib.go");
		const computeSym = impact.affectedSymbols.find((s) => s.symbol === "compute");
		expect(computeSym).toBeDefined();
		expect(computeSym!.callers).toBeGreaterThanOrEqual(1);
	});

	it("indexes multiple Go files in a workspace", async () => {
		writeFileSync(
			join(cwd, "util.go"),
			`package main

func add(a, b int) int {
	return a + b
}
`,
		);
		writeFileSync(
			join(cwd, "app.go"),
			`package main

import "fmt"

func run() {
	result := add(1, 2)
	fmt.Println(result)
}
`,
		);
		await indexer.ensureIndexed();

		const total = graph.listIndexedFiles();
		expect(total.length).toBe(2);

		const symbols = graph.findSymbols("add");
		expect(symbols.length).toBeGreaterThanOrEqual(1);
	});
});
