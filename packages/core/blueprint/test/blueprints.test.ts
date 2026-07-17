/**
 * Blueprint integration tests — compile, parse, load, discover, resolve.
 * No LLM, no filesystem side-effects beyond temp dirs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_RESOURCE_API_VERSION,
	AGENT_RESOURCE_KIND,
	compileAgentDefinition,
	findAgentDefinitionPath,
	loadAgentDefinition,
	mergeAgentDefinitions,
	parseAgentDefinitionYaml,
	resolveAgentChildDefinition,
} from "../src/blueprints.js";

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function tmpDir(prefix = "alef-bp-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// compileAgentDefinition
// ---------------------------------------------------------------------------

describe("compileAgentDefinition", { tags: ["unit"] }, () => {
	it("compiles a minimal definition", () => {
		const def = compileAgentDefinition({ name: "minimal" });
		expect(def.name).toBe("minimal");
		expect(def.adapters).toHaveLength(0);
		expect(def.capabilities.tools).toHaveLength(0);
		expect(def.capabilities.orchestration).toBe(false);
		expect(def.memory.session).toBe("memory");
		expect(def.policies.appendSystemPrompt).toHaveLength(0);
		expect(def.children).toHaveLength(0);
	});

	it("compiles fs adapter — name and empty actions when none specified", () => {
		const def = compileAgentDefinition({
			name: "fs-agent",
			adapters: [{ name: "fs" }],
		});
		expect(def.adapters).toHaveLength(1);
		const fs = def.adapters[0]!;
		expect(fs.name).toBe("fs");
		// Blueprint is purely structural — no static adapter catalog.
		// Actions default to [] when not specified; toolNames is always [].
		expect(fs.actions).toEqual([]);
		expect(fs.toolNames).toEqual([]);
	});

	it("compiles fs adapter with action allowlist — actions pass through verbatim", () => {
		const def = compileAgentDefinition({
			name: "read-only",
			adapters: [{ name: "fs", actions: ["read", "grep"] }],
		});
		const fs = def.adapters[0]!;
		expect(fs.actions).toEqual(["read", "grep"]);
		// toolNames is always [] — resolved at mount time, not compile time.
		expect(fs.toolNames).toEqual([]);
	});

	it("compiles shell adapter — name passes through", () => {
		const def = compileAgentDefinition({
			name: "shell-agent",
			adapters: [{ name: "shell" }],
		});
		expect(def.adapters[0]!.name).toBe("shell");
		expect(def.adapters[0]!.toolNames).toEqual([]);
	});

	it("compiles fs + shell — capabilities.tools is empty without explicit declaration", () => {
		const def = compileAgentDefinition({
			name: "full",
			adapters: [{ name: "fs" }, { name: "shell" }],
		});
		// Blueprint does not know tool names — adapters self-describe at mount time.
		expect(def.capabilities.tools).toEqual([]);
	});

	it("rejects duplicate adapters", () => {
		expect(() =>
			compileAgentDefinition({
				name: "dup",
				adapters: [{ name: "fs" }, { name: "fs" }],
			}),
		).toThrow(/duplicate adapter.*fs/i);
	});

	it("accepts any adapter name — validation is the materializer's concern", () => {
		// Blueprint is purely structural; it passes adapter names through verbatim.
		const def = compileAgentDefinition({
			name: "custom",
			adapters: [{ name: "weather" }],
		});
		expect(def.adapters[0]!.name).toBe("weather");
	});

	it("rejects orchestration adapter without capabilities.orchestration", () => {
		expect(() =>
			compileAgentDefinition({
				name: "bad-orch",
				adapters: [{ name: "orchestration" }],
			}),
		).toThrow(/orchestration adapter requires capabilities\.orchestration/i);
	});

	it("rejects capabilities.orchestration without orchestration adapter", () => {
		expect(() =>
			compileAgentDefinition({
				name: "bad-orch",
				capabilities: { orchestration: true },
			}),
		).toThrow(/capabilities\.orchestration.*requires an orchestration adapter/i);
	});

	it("accepts adapter with empty actions array", () => {
		// Blueprint no longer rejects empty action lists — structural only.
		const def = compileAgentDefinition({
			name: "no-actions",
			adapters: [{ name: "fs", actions: [] }],
		});
		expect(def.adapters[0]!.actions).toEqual([]);
	});

	it("normalises model string 'provider/model-id'", () => {
		const def = compileAgentDefinition({
			name: "m",
			model: "anthropic/claude-opus-4-5",
		});
		expect(def.model?.provider).toBe("anthropic");
		expect(def.model?.id).toBe("claude-opus-4-5");
	});

	it("rejects malformed model string", () => {
		expect(() => compileAgentDefinition({ name: "m", model: "nodivider" })).toThrow(/invalid model selector/i);
	});

	it("normalises systemPrompt with trim", () => {
		const def = compileAgentDefinition({
			name: "m",
			systemPrompt: "  be helpful  ",
		});
		expect(def.systemPrompt).toBe("be helpful");
	});

	it("captures memory, policies, and loop config", () => {
		const def = compileAgentDefinition({
			name: "full",
			memory: { session: "persistent", working: { x: 1 } },
			policies: { appendSystemPrompt: ["rule-a", "rule-b"] },
			loop: { maxTurnsPerRun: 5 },
		});
		expect(def.memory.session).toBe("persistent");
		expect(def.memory.working).toEqual({ x: 1 });
		expect(def.policies.appendSystemPrompt).toEqual(["rule-a", "rule-b"]);
		expect(def.loop?.maxTurnsPerRun).toBe(5);
	});

	it("resolves children relative to sourcePath", () => {
		const dir = tmpDir();
		const childPath = join(dir, "child.yaml");
		writeFileSync(childPath, "name: child\n");

		const def = compileAgentDefinition(
			{
				name: "parent",
				children: [{ name: "c", blueprint: "child.yaml" }],
			},
			{ sourcePath: join(dir, "parent.yaml") },
		);
		expect(def.children[0]!.blueprint).toBe(childPath);
	});
});

// ---------------------------------------------------------------------------
// parseAgentDefinitionYaml
// ---------------------------------------------------------------------------

describe("parseAgentDefinitionYaml", { tags: ["unit"] }, () => {
	it("parses bare YAML object", () => {
		const def = parseAgentDefinitionYaml("name: bare\n");
		expect(def.name).toBe("bare");
	});

	it("parses resource envelope (apiVersion + kind + metadata + spec)", () => {
		const yaml = `
apiVersion: ${AGENT_RESOURCE_API_VERSION}
kind: ${AGENT_RESOURCE_KIND}
metadata:
  name: envelope-agent
  labels:
    env: prod
spec:
  name: envelope-agent
  adapters:
    - name: fs
`.trim();
		const def = parseAgentDefinitionYaml(yaml);
		expect(def.name).toBe("envelope-agent");
		expect(def.resource?.apiVersion).toBe(AGENT_RESOURCE_API_VERSION);
		expect(def.resource?.kind).toBe(AGENT_RESOURCE_KIND);
		expect(def.resource?.metadata.labels.env).toBe("prod");
		expect(def.adapters[0]!.name).toBe("fs");
	});

	it("derives name from metadata.name when spec.name is absent", () => {
		const yaml = `
apiVersion: ${AGENT_RESOURCE_API_VERSION}
kind: ${AGENT_RESOURCE_KIND}
metadata:
  name: from-metadata
spec:
  adapters: []
`.trim();
		const def = parseAgentDefinitionYaml(yaml);
		expect(def.name).toBe("from-metadata");
	});

	it("throws on wrong apiVersion", () => {
		const yaml = `
apiVersion: other.io/v99
kind: ${AGENT_RESOURCE_KIND}
spec:
  name: x
`.trim();
		expect(() => parseAgentDefinitionYaml(yaml)).toThrow(/unsupported.*apiVersion/i);
	});

	it("throws on wrong kind", () => {
		const yaml = `
apiVersion: ${AGENT_RESOURCE_API_VERSION}
kind: WrongKind
spec:
  name: x
`.trim();
		expect(() => parseAgentDefinitionYaml(yaml)).toThrow(/unsupported.*kind/i);
	});

	it("throws when name is missing and metadata has no name", () => {
		const yaml = `
apiVersion: ${AGENT_RESOURCE_API_VERSION}
kind: ${AGENT_RESOURCE_KIND}
spec:
  adapters: []
`.trim();
		expect(() => parseAgentDefinitionYaml(yaml)).toThrow(/name.*required/i);
	});

	it("throws on non-object YAML input", () => {
		expect(() => parseAgentDefinitionYaml("- item1\n- item2\n")).toThrow();
	});

	it("passes unknown action names through without validation", () => {
		// Blueprint is structural — action validation is the materializer's concern.
		const yaml = `
name: passthrough
adapters:
  - name: fs
    actions: [nonexistent_action]
`.trim();
		const def = parseAgentDefinitionYaml(yaml);
		expect(def.adapters[0]!.actions).toEqual(["nonexistent_action"]);
	});
});

// ---------------------------------------------------------------------------
// loadAgentDefinition
// ---------------------------------------------------------------------------

describe("loadAgentDefinition", { tags: ["unit"] }, () => {
	it("loads a YAML file from disk", () => {
		const dir = tmpDir();
		const path = join(dir, "agent.yaml");
		writeFileSync(path, "name: disk-agent\n");

		const def = loadAgentDefinition(path);
		expect(def.name).toBe("disk-agent");
		expect(def.sourcePath).toBe(path);
	});

	it("throws when file does not exist", () => {
		expect(() => loadAgentDefinition("/nonexistent/path/agent.yaml")).toThrow(/not found/i);
	});

	it("sets sourcePath and baseDir from the file location", () => {
		const dir = tmpDir();
		const path = join(dir, "agent.yaml");
		writeFileSync(path, "name: located\n");

		const def = loadAgentDefinition(path);
		expect(def.sourcePath).toBe(path);
		expect(def.baseDir).toBe(dir);
	});
});

// ---------------------------------------------------------------------------
// findAgentDefinitionPath
// ---------------------------------------------------------------------------

describe("findAgentDefinitionPath", { tags: ["unit"] }, () => {
	it("finds agent.yaml in cwd", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "agent.yaml"), "name: found\n");
		expect(findAgentDefinitionPath(dir)).toBe(join(dir, "agent.yaml"));
	});

	it("finds agent.yml in cwd", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "agent.yml"), "name: found-yml\n");
		expect(findAgentDefinitionPath(dir)).toBe(join(dir, "agent.yml"));
	});

	it("finds agent.yaml at workspace root", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "agent.yaml"), "name: rootdef\n");
		expect(findAgentDefinitionPath(dir)).toBe(join(dir, "agent.yaml"));
	});

	it("prefers agent.yaml over agent.yml", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "agent.yaml"), "name: yaml\n");
		writeFileSync(join(dir, "agent.yml"), "name: yml\n");
		expect(findAgentDefinitionPath(dir)).toBe(join(dir, "agent.yaml"));
	});

	it("returns undefined when no blueprint found", () => {
		const dir = tmpDir();
		expect(findAgentDefinitionPath(dir)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// resolveAgentChildDefinition
// ---------------------------------------------------------------------------

describe("resolveAgentChildDefinition", { tags: ["unit"] }, () => {
	it("resolves by name from parent's children array", () => {
		const dir = tmpDir();
		const childPath = join(dir, "child.yaml");
		writeFileSync(childPath, "name: named-child\n");

		const parent = compileAgentDefinition(
			{
				name: "parent",
				children: [{ name: "worker", blueprint: "child.yaml" }],
			},
			{ sourcePath: join(dir, "parent.yaml") },
		);

		const child = resolveAgentChildDefinition(parent, "worker", dir);
		expect(child.name).toBe("named-child");
	});

	it("resolves by relative path when name not in children", () => {
		const dir = tmpDir();
		const childPath = join(dir, "other.yaml");
		writeFileSync(childPath, "name: path-child\n");

		const parent = compileAgentDefinition({ name: "parent" }, { sourcePath: join(dir, "parent.yaml") });

		const child = resolveAgentChildDefinition(parent, "other.yaml", dir);
		expect(child.name).toBe("path-child");
	});

	it("throws on empty reference", () => {
		expect(() => resolveAgentChildDefinition(undefined, "", "/tmp")).toThrow(/cannot be empty/i);
	});

	it("throws when resolved path does not exist", () => {
		expect(() => resolveAgentChildDefinition(undefined, "ghost.yaml", tmpDir())).toThrow(/not found/i);
	});
});

// ---------------------------------------------------------------------------
// Shipped bootstrap blueprints
// ---------------------------------------------------------------------------

describe("shipped bootstrap blueprints", { tags: ["unit"] }, () => {
	const BLUEPRINT_DIR = new URL("../examples/bootstrap", import.meta.url).pathname;

	it("loads gensec.yaml", () => {
		const def = loadAgentDefinition(join(BLUEPRINT_DIR, "gensec.yaml"));
		expect(def.name).toBe("gensec");
		expect(def.adapters.some((o) => o.name === "fs")).toBe(true);
		expect(def.adapters.some((o) => o.name === "shell")).toBe(true);
	});

	it("loads 2sec.yaml", () => {
		const def = loadAgentDefinition(join(BLUEPRINT_DIR, "2sec.yaml"));
		expect(def.name).toBe("2sec");
		expect(def.adapters.some((o) => o.name === "fs")).toBe(true);
	});

	it("loads primordial.yaml", () => {
		const def = loadAgentDefinition(join(BLUEPRINT_DIR, "primordial.yaml"));
		expect(def.name).toBe("primordial");
		const fs = def.adapters.find((o) => o.name === "fs");
		expect(fs).toBeDefined();
		// cache is an input field; CompiledAgentAdapterDefinition does not carry it.
		expect(fs?.name).toBe("fs");
	});

	it("gensec declares children pointing to 2sec", () => {
		const def = loadAgentDefinition(join(BLUEPRINT_DIR, "gensec.yaml"));
		expect(def.children.some((c) => c.name === "2sec")).toBe(true);
	});
});

describe("surfaces", { tags: ["unit"] }, () => {
	it("parses surfaces from YAML", () => {
		const def = parseAgentDefinitionYaml(`
name: test-agent
surfaces:
  - type: sse
    events:
      - dialog.message
      - fs.*
`);
		expect(def.surfaces).toHaveLength(1);
		expect(def.surfaces[0]!.type).toBe("sse");
		expect(def.surfaces[0]!.events).toEqual(["dialog.message", "fs.*"]);
	});

	it("defaults surfaces to empty array when not specified", () => {
		const def = parseAgentDefinitionYaml("name: test-agent\n");
		expect(def.surfaces).toEqual([]);
	});
});

describe("mergeAgentDefinitions", { tags: ["unit"] }, () => {
	it("overlay surfaces replace base surfaces when non-empty", () => {
		const base = parseAgentDefinitionYaml(`
name: base
surfaces:
  - type: sse
    events: ["dialog.message"]
`);
		const overlay = parseAgentDefinitionYaml(`
name: base
surfaces:
  - type: sse
    events: ["dialog.message", "fs.*", "shell.*"]
`);
		const merged = mergeAgentDefinitions(base, overlay);
		expect(merged.surfaces[0]!.events).toEqual(["dialog.message", "fs.*", "shell.*"]);
	});

	it("base surfaces preserved when overlay has none", () => {
		const base = parseAgentDefinitionYaml(`
name: base
surfaces:
  - type: sse
    events: ["dialog.message"]
`);
		const overlay = parseAgentDefinitionYaml("name: base\n");
		const merged = mergeAgentDefinitions(base, overlay);
		expect(merged.surfaces[0]!.events).toEqual(["dialog.message"]);
	});

	it("overlay model overrides base model", () => {
		const base = parseAgentDefinitionYaml("name: base\nmodel: anthropic/claude-haiku-3\n");
		const overlay = parseAgentDefinitionYaml("name: base\nmodel: anthropic/claude-sonnet-4-5\n");
		const merged = mergeAgentDefinitions(base, overlay);
		expect(merged.model?.id).toBe("claude-sonnet-4-5");
	});

	it("base model preserved when overlay has none", () => {
		const base = parseAgentDefinitionYaml("name: base\nmodel: anthropic/claude-haiku-3\n");
		const overlay = parseAgentDefinitionYaml("name: base\n");
		const merged = mergeAgentDefinitions(base, overlay);
		expect(merged.model?.id).toBe("claude-haiku-3");
	});

	it("overlay adapters union-merge with base adapters", () => {
		const base = parseAgentDefinitionYaml("name: base\nadapters:\n  - name: fs\n  - name: shell\n");
		const overlay = parseAgentDefinitionYaml("name: base\nadapters:\n  - name: code-intel\n");
		const merged = mergeAgentDefinitions(base, overlay);
		expect(merged.adapters.map((o) => o.name)).toEqual(["fs", "shell", "code-intel"]);
	});

	it("working memory is deep-merged, overlay wins per key", () => {
		const base = parseAgentDefinitionYaml("name: base\nmemory:\n  working:\n    a: 1\n    b: 2\n");
		const overlay = parseAgentDefinitionYaml("name: base\nmemory:\n  working:\n    b: 99\n    c: 3\n");
		const merged = mergeAgentDefinitions(base, overlay);
		expect(merged.memory.working).toEqual({ a: 1, b: 99, c: 3 });
	});
});
