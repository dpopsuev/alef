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

describe("compileAgentDefinition", () => {
	it("compiles a minimal definition", () => {
		const def = compileAgentDefinition({ name: "minimal" });
		expect(def.name).toBe("minimal");
		expect(def.organs).toHaveLength(0);
		expect(def.capabilities.tools).toHaveLength(0);
		expect(def.capabilities.supervisor).toBe(false);
		expect(def.memory.session).toBe("memory");
		expect(def.policies.appendSystemPrompt).toHaveLength(0);
		expect(def.children).toHaveLength(0);
	});

	it("compiles fs organ with default actions", () => {
		const def = compileAgentDefinition({
			name: "fs-agent",
			organs: [{ name: "fs" }],
		});
		expect(def.organs).toHaveLength(1);
		const fs = def.organs[0];
		expect(fs.name).toBe("fs");
		expect(fs.actions).toContain("read");
		expect(fs.actions).toContain("write");
		expect(fs.actions).toContain("edit");
		expect(fs.toolNames).toContain("file_read");
		expect(fs.toolNames).toContain("file_write");
		expect(fs.toolNames).toContain("file_edit");
	});

	it("compiles fs organ with action allowlist", () => {
		const def = compileAgentDefinition({
			name: "read-only",
			organs: [{ name: "fs", actions: ["read", "grep"] }],
		});
		const fs = def.organs[0];
		expect(fs.actions).toEqual(["read", "grep"]);
		expect(fs.toolNames).toContain("file_read");
		expect(fs.toolNames).toContain("file_grep");
		expect(fs.toolNames).not.toContain("file_write");
		expect(fs.toolNames).not.toContain("file_edit");
	});

	it("compiles shell organ", () => {
		const def = compileAgentDefinition({
			name: "shell-agent",
			organs: [{ name: "shell" }],
		});
		expect(def.organs[0].name).toBe("shell");
		expect(def.organs[0].toolNames).toContain("file_bash");
	});

	it("compiles fs + shell and aggregates toolNames in capabilities", () => {
		const def = compileAgentDefinition({
			name: "full",
			organs: [{ name: "fs" }, { name: "shell" }],
		});
		expect(def.capabilities.tools).toContain("file_read");
		expect(def.capabilities.tools).toContain("file_bash");
	});

	it("rejects duplicate organs", () => {
		expect(() =>
			compileAgentDefinition({
				name: "dup",
				organs: [{ name: "fs" }, { name: "fs" }],
			}),
		).toThrow(/duplicate organ.*fs/i);
	});

	it("rejects unsupported organ name", () => {
		expect(() =>
			compileAgentDefinition({
				name: "bad",
				// @ts-expect-error — deliberately invalid
				organs: [{ name: "weather" }],
			}),
		).toThrow();
	});

	it("rejects supervisor organ without capabilities.supervisor", () => {
		expect(() =>
			compileAgentDefinition({
				name: "bad-super",
				organs: [{ name: "supervisor" }],
			}),
		).toThrow(/supervisor organ requires capabilities\.supervisor/i);
	});

	it("rejects capabilities.supervisor without supervisor organ", () => {
		expect(() =>
			compileAgentDefinition({
				name: "bad-super",
				capabilities: { supervisor: true },
			}),
		).toThrow(/capabilities\.supervisor.*requires a supervisor organ/i);
	});

	it("rejects organ with zero selected actions", () => {
		expect(() =>
			compileAgentDefinition({
				name: "no-actions",
				organs: [{ name: "fs", actions: [] }],
			}),
		).toThrow();
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
		expect(def.children[0].blueprint).toBe(childPath);
	});
});

// ---------------------------------------------------------------------------
// parseAgentDefinitionYaml
// ---------------------------------------------------------------------------

describe("parseAgentDefinitionYaml", () => {
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
  organs:
    - name: fs
`.trim();
		const def = parseAgentDefinitionYaml(yaml);
		expect(def.name).toBe("envelope-agent");
		expect(def.resource?.apiVersion).toBe(AGENT_RESOURCE_API_VERSION);
		expect(def.resource?.kind).toBe(AGENT_RESOURCE_KIND);
		expect(def.resource?.metadata.labels.env).toBe("prod");
		expect(def.organs[0].name).toBe("fs");
	});

	it("derives name from metadata.name when spec.name is absent", () => {
		const yaml = `
apiVersion: ${AGENT_RESOURCE_API_VERSION}
kind: ${AGENT_RESOURCE_KIND}
metadata:
  name: from-metadata
spec:
  organs: []
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
  organs: []
`.trim();
		expect(() => parseAgentDefinitionYaml(yaml)).toThrow(/name.*required/i);
	});

	it("throws on non-object YAML input", () => {
		expect(() => parseAgentDefinitionYaml("- item1\n- item2\n")).toThrow();
	});

	it("throws on invalid organ action", () => {
		const yaml = `
name: bad
organs:
  - name: fs
    actions: [nonexistent_action]
`.trim();
		expect(() => parseAgentDefinitionYaml(yaml)).toThrow(/unsupported action/i);
	});
});

// ---------------------------------------------------------------------------
// loadAgentDefinition
// ---------------------------------------------------------------------------

describe("loadAgentDefinition", () => {
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

describe("findAgentDefinitionPath", () => {
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

	it("finds .alef/agent.yaml", () => {
		const dir = tmpDir();
		mkdirSync(join(dir, ".alef"), { recursive: true });
		writeFileSync(join(dir, ".alef", "agent.yaml"), "name: dotdir\n");
		expect(findAgentDefinitionPath(dir)).toBe(join(dir, ".alef", "agent.yaml"));
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

describe("resolveAgentChildDefinition", () => {
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

describe("shipped bootstrap blueprints", () => {
	const BLUEPRINT_DIR = new URL("../examples/bootstrap", import.meta.url).pathname;

	it("loads gensec.yaml", () => {
		const def = loadAgentDefinition(join(BLUEPRINT_DIR, "gensec.yaml"));
		expect(def.name).toBe("gensec");
		expect(def.organs.some((o) => o.name === "fs")).toBe(true);
		expect(def.organs.some((o) => o.name === "shell")).toBe(true);
	});

	it("loads 2sec.yaml", () => {
		const def = loadAgentDefinition(join(BLUEPRINT_DIR, "2sec.yaml"));
		expect(def.name).toBe("2sec");
		expect(def.organs.some((o) => o.name === "fs")).toBe(true);
	});

	it("loads primordial.yaml", () => {
		const def = loadAgentDefinition(join(BLUEPRINT_DIR, "primordial.yaml"));
		expect(def.name).toBe("primordial");
		const fs = def.organs.find((o) => o.name === "fs");
		expect(fs).toBeDefined();
		expect(fs?.cache?.enabled).toBe(true);
	});

	it("gensec declares children pointing to 2sec", () => {
		const def = loadAgentDefinition(join(BLUEPRINT_DIR, "gensec.yaml"));
		expect(def.children.some((c) => c.name === "2sec")).toBe(true);
	});
});
