/**
 * ToolShellOrgan unit tests — no PTY, no LLM, no filesystem.
 *
 * Pattern: Agent + BusEventRecorder. Publish motor events, assert sense results.
 * Mirrors corpus/test/walking-skeleton.test.ts.
 *
 * Covers:
 *   createToolShellOrgan — construction, metaTools shape
 *   tools.search         — keyword match, empty query, result shape
 *   tools.describe       — full schema + guidance, unknown names silently omitted
 *   buildOrganDirectives — index from organ list
 */

import type { ToolDefinition } from "@dpopsuev/alef-kernel";
import { Agent } from "@dpopsuev/alef-runtime";
import { BusEventRecorder } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildBootCatalog, buildOrganDirectives, createToolShellOrgan } from "../src/tool-shell.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTool(name: string, description: string): ToolDefinition {
	return { name, description, inputSchema: z.object({ path: z.string() }) };
}

const FS_READ = makeTool("fs.read", "Read raw text from a file");
const FS_GREP = makeTool("fs.grep", "Search file contents by regex pattern");
const FS_FIND = makeTool("fs.find", "Find files matching a glob pattern");
const SHELL_EXEC = makeTool("shell.exec", "Execute a bash command in a subprocess");
const WEB_FETCH = makeTool("web.fetch", "Fetch a URL and return its content");

const ALL_TOOLS = [FS_READ, FS_GREP, FS_FIND, SHELL_EXEC, WEB_FETCH];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
	agent: Agent;
	recorder: BusEventRecorder;
	publish(type: string, payload: Record<string, unknown>): void;
	senseResult(type: string): { results: unknown[] };
	dispose(): void;
}

function makeHarness(shell: ReturnType<typeof createToolShellOrgan>): Harness {
	const recorder = new BusEventRecorder();
	const agent = new Agent();
	agent.load(shell);
	agent.observe(recorder);

	return {
		agent,
		recorder,
		publish(type: string, payload: Record<string, unknown>) {
			// Use internal nerve via the agent's observe-recorded sense bus.
			// Publish directly via motor.publish on the agent's spine nerve.
			(agent as unknown as { nerve: { asNerve(): { motor: { publish(e: unknown): void } } } }).nerve
				.asNerve()
				.motor.publish({ type, payload, correlationId: "test" });
		},
		senseResult(type: string) {
			const evt = recorder.assertSenseEmitted(type);
			return (evt as unknown as { payload: { results: unknown[] } }).payload;
		},
		dispose() {
			agent.dispose();
		},
	};
}

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.dispose();
});
function make(opts: Parameters<typeof createToolShellOrgan>[0] = { tools: ALL_TOOLS }): Harness {
	const h = makeHarness(createToolShellOrgan(opts));
	harnesses.push(h);
	return h;
}

// ---------------------------------------------------------------------------
// createToolShellOrgan — shape
// ---------------------------------------------------------------------------

describe("createToolShellOrgan — metaTools", () => {
	it("exposes stripped domain tools + tools.describe", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		// N domain tools (stripped) + 1 tools.describe = N+1
		expect(shell.metaTools).toHaveLength(ALL_TOOLS.length + 1);
		expect(shell.metaTools.at(-1)?.name).toBe("tools.describe");
		// Domain tools have empty parameter schemas
		const fsRead = shell.metaTools.find((t) => t.name === "fs.read");
		expect(fsRead).toBeDefined();
		expect(fsRead?.description).toBe(FS_READ.description);
	});

	it("organ.tools (internal) contains only tools.describe handler", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		// organ.tools = tools with motor handlers (only tools.describe has one)
		expect(shell.tools.map((t) => t.name)).toEqual(["tools.describe"]);
	});

	it("organ.name is 'tools'", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		expect(shell.name).toBe("tools");
	});
});

// ---------------------------------------------------------------------------
// currentMetaTools — schema promotion (ALE-TSK-362)
// ---------------------------------------------------------------------------

describe("currentMetaTools — schema promotion", () => {
	it("initially identical shape to metaTools (all stripped)", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		const current = shell.currentMetaTools();
		expect(current).toHaveLength(ALL_TOOLS.length + 1);
		expect(current.at(-1)?.name).toBe("tools.describe");
		// No tool has been described yet — all stripped (inputSchema has no properties)
		const fsRead = current.find((t) => t.name === "fs.read");
		expect(fsRead).toBeDefined();
	});

	it("describing fs.read promotes all fs.* tools (family promotion via describe)", async () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		const harness = makeHarness(shell);
		harnesses.push(harness);

		harness.publish("tools.describe", { names: ["fs.read"] });
		await new Promise((r) => setTimeout(r, 50));

		const current = shell.currentMetaTools();
		// All fs.* tools promoted — LLM can call fs.edit without a second describe
		expect(current.find((t) => t.name === "fs.read")?.inputSchema).toBe(FS_READ.inputSchema);
		expect(current.find((t) => t.name === "fs.grep")?.inputSchema).toBe(FS_GREP.inputSchema);
		expect(current.find((t) => t.name === "fs.find")?.inputSchema).toBe(FS_FIND.inputSchema);
		// Different namespace — not promoted
		expect(current.find((t) => t.name === "shell.exec")?.inputSchema).not.toBe(SHELL_EXEC.inputSchema);
		expect(current.find((t) => t.name === "web.fetch")?.inputSchema).not.toBe(WEB_FETCH.inputSchema);
	});

	it("sense/fs.read result promotes all fs.* (auto-promotion without describe)", async () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		const recorder = new BusEventRecorder();
		const agent = new Agent();
		agent.load(shell);
		agent.observe(recorder);
		harnesses.push({
			agent,
			recorder,
			publish: () => {},
			senseResult: () => ({ results: [] }),
			dispose: () => agent.dispose(),
		});

		// Publish a Sense event directly simulating fs.read returning a result.
		agent.publishSense({ type: "fs.read", correlationId: "c1", payload: { content: "hello" }, isError: false });
		await new Promise((r) => setTimeout(r, 20));

		const current = shell.currentMetaTools();
		// fs.* family promoted from the Sense event alone — no describe call needed
		expect(current.find((t) => t.name === "fs.read")?.inputSchema).toBe(FS_READ.inputSchema);
		expect(current.find((t) => t.name === "fs.grep")?.inputSchema).toBe(FS_GREP.inputSchema);
		// shell.* not promoted
		expect(current.find((t) => t.name === "shell.exec")?.inputSchema).not.toBe(SHELL_EXEC.inputSchema);
	});

	it("describing shell.exec promotes shell.* but not fs.*", async () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		const harness = makeHarness(shell);
		harnesses.push(harness);

		harness.publish("tools.describe", { names: ["shell.exec"] });
		await new Promise((r) => setTimeout(r, 50));

		const current = shell.currentMetaTools();
		expect(current.find((t) => t.name === "shell.exec")?.inputSchema).toBe(SHELL_EXEC.inputSchema);
		expect(current.find((t) => t.name === "fs.read")?.inputSchema).not.toBe(FS_READ.inputSchema);
	});

	it("multiple describe calls union their promoted families", async () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		const harness = makeHarness(shell);
		harnesses.push(harness);

		harness.publish("tools.describe", { names: ["fs.read", "shell.exec"] });
		await new Promise((r) => setTimeout(r, 50));

		const current = shell.currentMetaTools();
		// Both fs.* and shell.* promoted
		expect(current.find((t) => t.name === "fs.grep")?.inputSchema).toBe(FS_GREP.inputSchema);
		expect(current.find((t) => t.name === "shell.exec")?.inputSchema).toBe(SHELL_EXEC.inputSchema);
		// web.* still stripped
		expect(current.find((t) => t.name === "web.fetch")?.inputSchema).not.toBe(WEB_FETCH.inputSchema);
	});

	it("always appends tools.describe last", async () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		const harness = makeHarness(shell);
		harnesses.push(harness);
		harness.publish("tools.describe", { names: ["fs.read"] });
		await new Promise((r) => setTimeout(r, 50));

		const current = shell.currentMetaTools();
		expect(current.at(-1)?.name).toBe("tools.describe");
	});
});

// ---------------------------------------------------------------------------
// internal search (not exposed as motor handler)
// ---------------------------------------------------------------------------

describe("ToolShellOrgan.search — internal keyword matching", () => {
	it("returns tools matching a single keyword", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		const results = shell.search("file");
		const names = results.map((r) => r.name);
		expect(names).toContain("fs.find");
		expect(names).not.toContain("shell.exec");
	});

	it("returns all tools on empty query", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		expect(shell.search("").length).toBe(ALL_TOOLS.length);
	});

	it("returns only name and description, not schema", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		for (const r of shell.search("read") as Array<Record<string, unknown>>) {
			expect(r).not.toHaveProperty("schema");
			expect(r).not.toHaveProperty("guidance");
			expect(r).toHaveProperty("name");
			expect(r).toHaveProperty("description");
		}
	});

	it("matches on description words too", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		const names = shell.search("regex").map((r) => r.name);
		expect(names).toContain("fs.grep");
	});
});

// ---------------------------------------------------------------------------
// tools.describe
// ---------------------------------------------------------------------------

describe("tools.describe — full schema on demand", () => {
	it("returns schema and guidance for a known tool", async () => {
		const directives = new Map([["fs.read", ["Always use offset/limit for large files."]]]);
		const h = make({ tools: ALL_TOOLS, organDirectives: directives });
		h.publish("tools.describe", { names: ["fs.read"] });
		await new Promise((r) => setTimeout(r, 100));
		const { results } = h.senseResult("tools.describe");
		expect((results as unknown[]).length).toBe(1);
		const entry = (results as Array<Record<string, unknown>>)[0];
		expect(entry.name).toBe("fs.read");
		expect(entry).toHaveProperty("schema");
		expect(entry.guidance).toContain("offset/limit");
	});

	it("silently omits unknown tool names", async () => {
		const h = make();
		h.publish("tools.describe", { names: ["fs.read", "nonexistent.tool"] });
		await new Promise((r) => setTimeout(r, 100));
		const { results } = h.senseResult("tools.describe");
		expect((results as unknown[]).length).toBe(1);
		expect((results as Array<{ name: string }>)[0].name).toBe("fs.read");
	});

	it("returns empty guidance when no directives registered", async () => {
		const h = make();
		h.publish("tools.describe", { names: ["shell.exec"] });
		await new Promise((r) => setTimeout(r, 100));
		const { results } = h.senseResult("tools.describe");
		expect((results as Array<{ guidance: string }>)[0].guidance).toBe("");
	});

	it("empty names returns full catalog (all tool names + descriptions, no schemas)", async () => {
		const h = make();
		h.publish("tools.describe", { names: [] });
		await new Promise((r) => setTimeout(r, 100));
		const { results } = h.senseResult("tools.describe");
		const names = (results as { name: string }[]).map((r) => r.name).sort();
		expect(names.length).toBeGreaterThan(0);
		expect(names).toContain("fs.read");
		// Catalog entries have no schema (empty object).
		const schemas = (results as { schema: Record<string, unknown> }[]).map((r) => r.schema);
		expect(schemas.every((s) => Object.keys(s).length === 0)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// buildOrganDirectives
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildBootCatalog
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Context lifecycle — catalog inject / evict
// ---------------------------------------------------------------------------

describe("ToolShellOrgan lifecycle — catalog injection and eviction", () => {
	const MARKER = "\x00TOOL-CATALOG-v1\x00";

	function msgs(n: number): Array<Record<string, unknown>> {
		return Array.from({ length: n }, (_, i) => ({ role: "user", content: `msg ${i}` }));
	}

	it("injects catalog message on turn 1", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		const result = shell.applyPhase(msgs(1), 1);
		expect(result.length).toBe(2);
		const first = result[0].content as string;
		expect(first).toContain(MARKER);
		expect(first).toContain("fs.read");
	});

	it("does not inject catalog twice", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS });
		const after1 = shell.applyPhase(msgs(1), 1);
		const after2 = shell.applyPhase(after1, 2);
		const count = after2.filter(
			(m) => typeof m.content === "string" && (m.content as string).includes(MARKER),
		).length;
		expect(count).toBe(1);
	});

	it("evicts catalog after evictAfterTurn", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS, evictAfterTurn: 2 });
		let m = msgs(1);
		m = shell.applyPhase(m, 1); // inject
		m = shell.applyPhase(m, 2); // persist
		m = shell.applyPhase(m, 3); // evict
		expect(
			m.find((msg) => typeof msg.content === "string" && (msg.content as string).includes(MARKER)),
		).toBeUndefined();
		expect(
			m.find((msg) => typeof msg.content === "string" && (msg.content as string).includes("compacted")),
		).toBeDefined();
	});

	it("eviction message lists remaining tools", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS, evictAfterTurn: 1 });
		let m = shell.applyPhase(msgs(1), 1);
		m = shell.applyPhase(m, 2); // evict
		const summary = m.find((msg) => typeof msg.content === "string" && (msg.content as string).includes("compacted"));
		expect(summary?.content as string).toContain("Still available");
	});

	it("evictAfterTurn=Infinity disables eviction", () => {
		const shell = createToolShellOrgan({ tools: ALL_TOOLS, evictAfterTurn: Infinity });
		let m = msgs(1);
		m = shell.applyPhase(m, 1);
		for (let t = 2; t <= 20; t++) m = shell.applyPhase(m, t);
		expect(
			m.find((msg) => typeof msg.content === "string" && (msg.content as string).includes(MARKER)),
		).toBeDefined();
	});
});

describe("buildBootCatalog", () => {
	it("includes all tool names", () => {
		const catalog = buildBootCatalog(ALL_TOOLS);
		for (const t of ALL_TOOLS) {
			expect(catalog).toContain(t.name);
		}
	});

	it("includes all tool descriptions", () => {
		const catalog = buildBootCatalog(ALL_TOOLS);
		for (const t of ALL_TOOLS) {
			expect(catalog).toContain(t.description);
		}
	});

	it("contains tools.describe instruction and omits tools.search instruction", () => {
		const catalog = buildBootCatalog(ALL_TOOLS);
		expect(catalog).toContain("tools.describe");
		expect(catalog).toContain("Do NOT call");
	});

	it("sorts tools alphabetically", () => {
		const catalog = buildBootCatalog(ALL_TOOLS);
		const names = ALL_TOOLS.map((t) => t.name).sort();
		const positions = names.map((n) => catalog.indexOf(n));
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it("returns empty catalog body for empty tool list", () => {
		const catalog = buildBootCatalog([]);
		expect(catalog).toContain("## Available Tools");
		expect(catalog).not.toContain("**fs.");
	});
});

describe("buildOrganDirectives", () => {
	it("maps each tool in an organ to that organ's directives", () => {
		const organs = [
			{ tools: [FS_READ, FS_GREP], directives: ["Use offset/limit for large files."] },
			{ tools: [SHELL_EXEC], directives: ["Avoid long-running commands."] },
		];
		const map = buildOrganDirectives(organs);
		expect(map.get("fs.read")).toEqual(["Use offset/limit for large files."]);
		expect(map.get("fs.grep")).toEqual(["Use offset/limit for large files."]);
		expect(map.get("shell.exec")).toEqual(["Avoid long-running commands."]);
	});

	it("skips organs with no directives", () => {
		const organs = [
			{ tools: [FS_READ], directives: undefined },
			{ tools: [SHELL_EXEC], directives: [] },
		];
		const map = buildOrganDirectives(organs);
		expect(map.size).toBe(0);
	});

	it("last writer wins when multiple organs share a tool name", () => {
		const organs = [
			{ tools: [FS_READ], directives: ["First directive."] },
			{ tools: [FS_READ], directives: ["Second directive."] },
		];
		const map = buildOrganDirectives(organs);
		expect(map.get("fs.read")).toEqual(["Second directive."]);
	});
});
