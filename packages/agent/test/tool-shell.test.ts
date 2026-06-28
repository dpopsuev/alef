/**
 * ToolShellOrgan unit tests — no PTY, no LLM, no filesystem.
 *
 * Pattern: Agent + BusEventRecorder. Publish command events, assert sense results.
 * Mirrors runtime/test/walking-skeleton.test.ts.
 *
 * Covers:
 * createToolShellAdapter — construction, metaTools shape
 * tools.search — keyword match, empty query, result shape
 * tools.describe — full schema + guidance, unknown names silently omitted
 * buildAdapterDirectives — index from adapter list
 */

import { Agent } from "@dpopsuev/alef-engine/agent";
import { buildAdapterDirectives, buildBootCatalog, createToolShellAdapter } from "@dpopsuev/alef-engine/catalog";
import type { Adapter, AdapterLogger, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import { BusEventRecorder } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

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

function makeHarness(shell: ReturnType<typeof createToolShellAdapter>): Harness {
	const recorder = new BusEventRecorder();
	const agent = new Agent();
	agent.load(shell);
	agent.observe(recorder);

	return {
		agent,
		recorder,
		publish(type: string, payload: Record<string, unknown>) {
			// Use internal bus via the agent's observe-recorded event bus.
			// Publish directly via command.publish on the agent's spine bus.
			(agent as unknown as { bus: { asBus(): { command: { publish(e: unknown): void } } } }).bus
				.asBus()
				.command.publish({ type, payload, correlationId: "test" });
		},
		senseResult(type: string) {
			const evt = recorder.assertEventEmitted(type);
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
function make(opts: Parameters<typeof createToolShellAdapter>[0] = { tools: ALL_TOOLS }): Harness {
	const h = makeHarness(createToolShellAdapter(opts));
	harnesses.push(h);
	return h;
}

// ---------------------------------------------------------------------------
// createToolShellAdapter — shape
// ---------------------------------------------------------------------------

describe("createToolShellAdapter — metaTools", { tags: ["unit"] }, () => {
	it("exposes stripped domain tools + tools.describe", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS });
		// N domain tools (stripped) + 1 tools.describe = N+1
		expect(shell.metaTools).toHaveLength(ALL_TOOLS.length + 1);
		expect(shell.metaTools.at(-1)?.name).toBe("tools.describe");
		// Domain tools have empty parameter schemas
		const fsRead = shell.metaTools.find((t) => t.name === "fs.read");
		expect(fsRead).toBeDefined();
		expect(fsRead?.description).toBe(FS_READ.description);
	});

	it("organ.tools (internal) contains meta-tool handlers", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS });
		const names = shell.tools.map((t) => t.name);
		expect(names).toContain("tools.describe");
		expect(names).toContain("tools.status");
		expect(names).toContain("tools.cancel");
	});

	it("organ.name is 'tools'", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS });
		expect(shell.name).toBe("tools");
	});
});

// ---------------------------------------------------------------------------
// currentMetaTools — schema promotion
// ---------------------------------------------------------------------------

describe("currentMetaTools — schema promotion", { tags: ["unit"] }, () => {
	it("initially identical shape to metaTools (all stripped)", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "progressive" });
		const current = shell.currentMetaTools();
		expect(current).toHaveLength(ALL_TOOLS.length + 1);
		expect(current.at(-1)?.name).toBe("tools.describe");
		// No tool has been described yet — all stripped (inputSchema has no properties)
		const fsRead = current.find((t) => t.name === "fs.read");
		expect(fsRead).toBeDefined();
	});

	it("describing fs.read promotes all fs.* tools (family promotion via describe)", async () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "progressive" });
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

	it("event/fs.read result promotes all fs.* (auto-promotion without describe)", async () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "progressive" });
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
		agent.publishEvent({ type: "fs.read", correlationId: "c1", payload: { content: "hello" }, isError: false });
		await new Promise((r) => setTimeout(r, 20));

		const current = shell.currentMetaTools();
		// fs.* family promoted from the Sense event alone — no describe call needed
		expect(current.find((t) => t.name === "fs.read")?.inputSchema).toBe(FS_READ.inputSchema);
		expect(current.find((t) => t.name === "fs.grep")?.inputSchema).toBe(FS_GREP.inputSchema);
		// shell.* not promoted
		expect(current.find((t) => t.name === "shell.exec")?.inputSchema).not.toBe(SHELL_EXEC.inputSchema);
	});

	it("describing shell.exec promotes shell.* but not fs.*", async () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "progressive" });
		const harness = makeHarness(shell);
		harnesses.push(harness);

		harness.publish("tools.describe", { names: ["shell.exec"] });
		await new Promise((r) => setTimeout(r, 50));

		const current = shell.currentMetaTools();
		expect(current.find((t) => t.name === "shell.exec")?.inputSchema).toBe(SHELL_EXEC.inputSchema);
		expect(current.find((t) => t.name === "fs.read")?.inputSchema).not.toBe(FS_READ.inputSchema);
	});

	it("multiple describe calls union their promoted families", async () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "progressive" });
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
		const shell = createToolShellAdapter({ tools: ALL_TOOLS });
		const harness = makeHarness(shell);
		harnesses.push(harness);
		harness.publish("tools.describe", { names: ["fs.read"] });
		await new Promise((r) => setTimeout(r, 50));

		const current = shell.currentMetaTools();
		expect(current.at(-1)?.name).toBe("tools.describe");
	});
});

// ---------------------------------------------------------------------------
// Full disclosure — all schemas always present, no stripping
// ---------------------------------------------------------------------------

describe("currentMetaTools — full disclosure", { tags: ["unit"] }, () => {
	it("all tools have full schemas from the start", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "full" });
		const current = shell.currentMetaTools();
		expect(current.find((t) => t.name === "fs.read")?.inputSchema).toBe(FS_READ.inputSchema);
		expect(current.find((t) => t.name === "shell.exec")?.inputSchema).toBe(SHELL_EXEC.inputSchema);
		expect(current.find((t) => t.name === "web.fetch")?.inputSchema).toBe(WEB_FETCH.inputSchema);
	});

	it("describe is a no-op — schemas unchanged", async () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "full" });
		const harness = makeHarness(shell);
		harnesses.push(harness);

		const before = shell.currentMetaTools();
		harness.publish("tools.describe", { names: ["fs.read"] });
		await new Promise((r) => setTimeout(r, 50));
		const after = shell.currentMetaTools();

		expect(after.find((t) => t.name === "fs.read")?.inputSchema).toBe(before.find((t) => t.name === "fs.read")?.inputSchema);
		expect(after.find((t) => t.name === "shell.exec")?.inputSchema).toBe(before.find((t) => t.name === "shell.exec")?.inputSchema);
	});

	it("applyPhase does not inject catalog", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "full" });
		const input = [{ role: "user", content: "hello" }];
		const result = shell.applyPhase(input, 1);
		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("hello");
	});

	it("applyPhase does not evict (no catalog to evict)", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "full", evictAfterTurn: 1 });
		let m = [{ role: "user", content: "hello" }];
		m = shell.applyPhase(m, 1);
		m = shell.applyPhase(m, 5);
		expect(m).toHaveLength(1);
		expect(m[0].content).toBe("hello");
	});
});

// ---------------------------------------------------------------------------
// internal search (not exposed as command handler)
// ---------------------------------------------------------------------------

describe("ToolShellOrgan.search — internal keyword matching", { tags: ["unit"] }, () => {
	it("returns tools matching a single keyword", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS });
		const results = shell.search("file");
		const names = results.map((r) => r.name);
		expect(names).toContain("fs.find");
		expect(names).not.toContain("shell.exec");
	});

	it("returns all tools on empty query", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS });
		expect(shell.search("").length).toBe(ALL_TOOLS.length);
	});

	it("returns only name and description, not schema", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS });
		for (const r of shell.search("read") as Array<Record<string, unknown>>) {
			expect(r).not.toHaveProperty("schema");
			expect(r).not.toHaveProperty("guidance");
			expect(r).toHaveProperty("name");
			expect(r).toHaveProperty("description");
		}
	});

	it("matches on description words too", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS });
		const names = shell.search("regex").map((r) => r.name);
		expect(names).toContain("fs.grep");
	});
});

// ---------------------------------------------------------------------------
// tools.describe
// ---------------------------------------------------------------------------

describe("tools.describe — full schema on demand", { tags: ["unit"] }, () => {
	it("returns schema and guidance for a known tool", async () => {
		const directives = new Map([["fs.read", ["Always use offset/limit for large files."]]]);
		const h = make({ tools: ALL_TOOLS, adapterDirectives: directives });
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
// buildAdapterDirectives
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildBootCatalog
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Context lifecycle — catalog inject / evict
// ---------------------------------------------------------------------------

describe("ToolShellOrgan lifecycle — catalog injection and eviction", { tags: ["unit"] }, () => {
	const MARKER = "\x00TOOL-CATALOG-v1\x00";

	function msgs(n: number): Array<Record<string, unknown>> {
		return Array.from({ length: n }, (_, i) => ({ role: "user", content: `msg ${i}` }));
	}

	it("injects catalog message on turn 1", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "progressive" });
		const result = shell.applyPhase(msgs(1), 1);
		expect(result.length).toBe(2);
		const first = result[0].content as string;
		expect(first).toContain(MARKER);
		expect(first).toContain("fs.read");
	});

	it("does not inject catalog twice", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "progressive" });
		const after1 = shell.applyPhase(msgs(1), 1);
		const after2 = shell.applyPhase(after1, 2);
		const count = after2.filter(
			(m) => typeof m.content === "string" && (m.content as string).includes(MARKER),
		).length;
		expect(count).toBe(1);
	});

	it("evicts catalog after evictAfterTurn", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "progressive", evictAfterTurn: 2 });
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
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "progressive", evictAfterTurn: 1 });
		let m = shell.applyPhase(msgs(1), 1);
		m = shell.applyPhase(m, 2); // evict
		const summary = m.find((msg) => typeof msg.content === "string" && (msg.content as string).includes("compacted"));
		expect(summary?.content as string).toContain("Still available");
	});

	it("evictAfterTurn=Infinity disables eviction", () => {
		const shell = createToolShellAdapter({ tools: ALL_TOOLS, disclosure: "progressive", evictAfterTurn: Infinity });
		let m = msgs(1);
		m = shell.applyPhase(m, 1);
		for (let t = 2; t <= 20; t++) m = shell.applyPhase(m, t);
		expect(
			m.find((msg) => typeof msg.content === "string" && (msg.content as string).includes(MARKER)),
		).toBeDefined();
	});
});

describe("buildBootCatalog", { tags: ["unit"] }, () => {
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

// ---------------------------------------------------------------------------
// tools:describe:miss warn log
// ---------------------------------------------------------------------------

describe("tools.describe — miss warn log", { tags: ["unit"] }, () => {
	it("emits tools:describe:miss warn log with name when tool is not in catalog", async () => {
		type CapturedLog = { level: string; obj: Record<string, unknown>; msg: string };
		const capturedLogs: CapturedLog[] = [];

		const spyLogger: AdapterLogger = {
			debug(obj, msg) {
				capturedLogs.push({ level: "debug", obj: obj as Record<string, unknown>, msg: msg ?? "" });
			},
			info(obj, msg) {
				capturedLogs.push({ level: "info", obj: obj as Record<string, unknown>, msg: msg ?? "" });
			},
			warn(obj, msg) {
				capturedLogs.push({ level: "warn", obj: obj as Record<string, unknown>, msg: msg ?? "" });
			},
			error(obj, msg) {
				capturedLogs.push({ level: "error", obj: obj as Record<string, unknown>, msg: msg ?? "" });
			},
			child(bindings) {
				return {
					...spyLogger,
					warn(obj, msg) {
						capturedLogs.push({
							level: "warn",
							obj: { ...bindings, ...(obj as Record<string, unknown>) },
							msg: msg ?? "",
						});
					},
				} as AdapterLogger;
			},
		};

		const shell = createToolShellAdapter({ tools: [FS_READ], logger: spyLogger });
		const h = makeHarness(shell);
		harnesses.push(h);

		h.publish("tools.describe", { names: ["agent.run"] });
		await new Promise((r) => setTimeout(r, 100));

		const { results } = h.senseResult("tools.describe");
		expect((results as unknown[]).length).toBe(0);

		const missLog = capturedLogs.find((l) => l.level === "warn" && l.msg === "tools:describe:miss");
		expect(missLog, "tools:describe:miss warn log must be emitted").toBeDefined();
		expect((missLog?.obj as { name?: string }).name).toBe("agent.run");
	});
});

describe("buildAdapterDirectives", { tags: ["unit"] }, () => {
	it("maps each tool in an organ to that organ's directives", () => {
		const organs = [
			{ tools: [FS_READ, FS_GREP], directives: ["Use offset/limit for large files."] },
			{ tools: [SHELL_EXEC], directives: ["Avoid long-running commands."] },
		];
		const map = buildAdapterDirectives(organs);
		expect(map.get("fs.read")).toEqual(["Use offset/limit for large files."]);
		expect(map.get("fs.grep")).toEqual(["Use offset/limit for large files."]);
		expect(map.get("shell.exec")).toEqual(["Avoid long-running commands."]);
	});

	it("skips organs with no directives", () => {
		const organs = [
			{ tools: [FS_READ], directives: undefined },
			{ tools: [SHELL_EXEC], directives: [] },
		];
		const map = buildAdapterDirectives(organs);
		expect(map.size).toBe(0);
	});

	it("last writer wins when multiple organs share a tool name", () => {
		const organs = [
			{ tools: [FS_READ], directives: ["First directive."] },
			{ tools: [FS_READ], directives: ["Second directive."] },
		];
		const map = buildAdapterDirectives(organs);
		expect(map.get("fs.read")).toEqual(["Second directive."]);
	});
});

// ---------------------------------------------------------------------------
// agent.run in tools.describe catalog (no full server boot)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// agent.tools — uniqueness invariant
//
// agent._tools is a plain push-append array. If two organs expose a tool with
// the same name, both entries land in agent.tools, which is passed verbatim to
// buildTools → LLM API. The API rejects with "Tool names must be unique."
// ---------------------------------------------------------------------------

describe("agent.tools — uniqueness invariant", { tags: ["integration"] }, () => {
	function stubOrgan(name: string, tools: ToolDefinition[]): Adapter {
		return {
			name,
			tools,
			subscriptions: { command: [], event: [], notification: [] },
			sources: [],
			mount() {
				return () => {};
			},
		};
	}

	it("loading two organs that share a tool name must not produce duplicate agent.tools entries", () => {
		// Both organs declare fs.read — the second load appends a duplicate to agent._tools.
		const organA = stubOrgan("organ-a", [FS_READ]);
		const organB = stubOrgan("organ-b", [makeTool("fs.read", "A second organ that also exposes fs.read")]);

		const agent = new Agent();
		agent.load(organA);
		agent.load(organB);

		const names = agent.tools.map((t) => t.name);
		expect(new Set(names).size, `agent.tools must have no duplicate names; got: ${names.join(", ")}`).toBe(
			names.length,
		);

		agent.dispose();
	});
});

describe("tools.describe catalog includes agent.run when included in tools list", { tags: ["integration"] }, () => {
	const AGENT_RUN: ToolDefinition = {
		name: "agent.run",
		description: "Delegate a task to an in-process subagent and return its reply.",
		inputSchema: z.object({ text: z.string(), profile: z.string().optional() }),
	};

	it("tools.describe({ names: [] }) payload.results contains agent.run", async () => {
		const tools = [...ALL_TOOLS, AGENT_RUN];
		const h = makeHarness(createToolShellAdapter({ tools }));
		harnesses.push(h);

		h.publish("tools.describe", { names: [] });
		await new Promise((r) => setTimeout(r, 100));

		const { results } = h.senseResult("tools.describe");
		const names = (results as Array<{ name: string }>).map((r) => r.name);
		expect(names).toContain("agent.run");
	});

	it("agent.run is in agent.tools after organ load via shell.search", () => {
		const tools = [...ALL_TOOLS, AGENT_RUN];
		const shell = createToolShellAdapter({ tools });
		const agent = new Agent();
		agent.load(shell);
		harnesses.push({
			agent,
			recorder: new BusEventRecorder(),
			publish: () => {},
			senseResult: () => ({ results: [] }),
			dispose: () => agent.dispose(),
		});

		const catalogNames = shell.search("").map((r) => r.name);
		expect(catalogNames).toContain("agent.run");
		expect(agent.tools.map((t) => t.name)).toContain("tools.describe");
	});
});
