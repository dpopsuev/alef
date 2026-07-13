import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAgentDefinition } from "@dpopsuev/alef-blueprint/blueprints";
import {
	loadAdapterFromPath,
	loadUserAdaptersConfig,
	materializeBlueprint,
} from "@dpopsuev/alef-blueprint/materializer";
import { afterEach, describe, expect, it } from "vitest";

const CWD = "/tmp/test-workspace";

const temps: string[] = [];
afterEach(() => {
	for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "mat-test-"));
	temps.push(d);
	return d;
}

function makeDefinition(adapters: { name: string; actions?: string[] }[]) {
	return compileAgentDefinition({
		name: "test-agent",
		adapters: adapters.map((o) => ({
			name: o.name as "fs" | "shell",
			actions: o.actions,
		})),
	});
}

describe("materializeBlueprint", { tags: ["unit"] }, () => {
	it("returns empty adapter list when no adapters declared", async () => {
		const def = compileAgentDefinition({ name: "empty" });
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.adapters).toHaveLength(0);
		expect(result.modelId).toBeUndefined();
	});

	it("instantiates FsAdapter for fs adapter", async () => {
		const def = makeDefinition([{ name: "fs" }]);
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.adapters).toHaveLength(1);
		expect(result.adapters[0]!.name).toBe("fs");
	});

	it("instantiates ShellAdapter for shell adapter", async () => {
		const def = makeDefinition([{ name: "shell" }]);
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.adapters).toHaveLength(1);
		expect(result.adapters[0]!.name).toBe("shell");
	});

	it("instantiates both fs and shell", async () => {
		const def = makeDefinition([{ name: "fs" }, { name: "shell" }]);
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.adapters).toHaveLength(2);
		expect(result.adapters.map((o) => o.name)).toEqual(["fs", "shell"]);
	});

	it("lector adapter is now supported in the EDA runtime", async () => {
		const def = compileAgentDefinition({
			name: "lector-agent",
			adapters: [{ name: "code-intel" }],
		});
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.adapters).toHaveLength(1);
		expect(result.adapters[0]!.name).toBe("code-intel");
	});

	it("skips truly unsupported adapters (symbols) without throwing", async () => {
		const def = compileAgentDefinition({
			name: "advanced",
			adapters: [{ name: "fs" }, { name: "symbols" }],
		});
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.adapters).toHaveLength(1);
		expect(result.adapters[0]!.name).toBe("fs");
	});

	it("returns modelId from blueprint model field", async () => {
		const def = compileAgentDefinition({
			name: "model-agent",
			model: "anthropic/claude-opus-4-5",
		});
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.modelId).toBe("anthropic/claude-opus-4-5");
	});

	it("returns undefined modelId when blueprint has no model", async () => {
		const def = compileAgentDefinition({ name: "no-model" });
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.modelId).toBeUndefined();
	});

	it("respects action allowlist on fs adapter", async () => {
		const def = makeDefinition([{ name: "fs", actions: ["read"] }]);
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.adapters).toHaveLength(1);
		const adapter = result.adapters[0]!;
		expect(adapter.tools.some((t) => t.name === "fs.read")).toBe(true);
		expect(adapter.tools.some((t) => t.name === "fs.write")).toBe(false);
	});
});

describe("loadAdapterFromPath", { tags: ["unit"] }, () => {
	it("loads a TypeScript adapter file and calls createAdapter()", async () => {
		const dir = makeTmp();
		const adapterFile = join(dir, "my-adapter.ts");
		writeFileSync(
			adapterFile,
			`
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
export function createAdapter(_opts: unknown): Adapter {
	return {
		name: "my-adapter",
		tools: [],
		subscriptions: { command: [], event: [] },
		mount: () => () => {},
	};
}
`,
		);
		const adapter = await loadAdapterFromPath(adapterFile, { cwd: dir });
		expect(adapter.name).toBe("my-adapter");
		expect(adapter.tools).toHaveLength(0);
	});

	it("throws when file does not export createAdapter", async () => {
		const dir = makeTmp();
		const adapterFile = join(dir, "bad-adapter.ts");
		writeFileSync(adapterFile, "export const foo = 42;");
		await expect(loadAdapterFromPath(adapterFile, { cwd: dir })).rejects.toThrow("createAdapter");
	});
});

describe("loadUserAdaptersConfig", { tags: ["unit"] }, () => {
	it("returns null when adapters.yaml does not exist", () => {
		const dir = makeTmp();
		process.env.ALEF_PM_ROOT = dir;
		try {
			expect(loadUserAdaptersConfig()).toBeNull();
		} finally {
			delete process.env.ALEF_PM_ROOT;
		}
	});

	it("parses a flat string list", () => {
		const dir = makeTmp();
		writeFileSync(join(dir, "adapters.yaml"), "adapters:\n  - fs\n  - shell\n");
		process.env.ALEF_PM_ROOT = dir;
		try {
			const result = loadUserAdaptersConfig();
			expect(result).not.toBeNull();
			expect(result?.map((o) => o.name)).toEqual(["fs", "shell"]);
			expect(result?.every((o) => o.actions.length === 0)).toBe(true);
		} finally {
			delete process.env.ALEF_PM_ROOT;
		}
	});

	it("parses object entries with name, path, and actions", () => {
		const dir = makeTmp();
		writeFileSync(
			join(dir, "adapters.yaml"),
			[
				"adapters:",
				"  - name: fs",
				"    actions: [read]",
				"  - name: my-adapter",
				"    path: /adapters/my-adapter.ts",
			].join("\n"),
		);
		process.env.ALEF_PM_ROOT = dir;
		try {
			const result = loadUserAdaptersConfig();
			expect(result).toHaveLength(2);
			expect(result?.[0]).toMatchObject({ name: "fs", actions: ["read"] });
			expect(result?.[1]).toMatchObject({ name: "my-adapter", path: "/adapters/my-adapter.ts" });
		} finally {
			delete process.env.ALEF_PM_ROOT;
		}
	});

	it("returns null for a file with no adapters key", () => {
		const dir = makeTmp();
		writeFileSync(join(dir, "adapters.yaml"), "model: anthropic/claude\n");
		process.env.ALEF_PM_ROOT = dir;
		try {
			expect(loadUserAdaptersConfig()).toBeNull();
		} finally {
			delete process.env.ALEF_PM_ROOT;
		}
	});

	it("returns null for an empty file", () => {
		const dir = makeTmp();
		writeFileSync(join(dir, "adapters.yaml"), "");
		process.env.ALEF_PM_ROOT = dir;
		try {
			expect(loadUserAdaptersConfig()).toBeNull();
		} finally {
			delete process.env.ALEF_PM_ROOT;
		}
	});
});
