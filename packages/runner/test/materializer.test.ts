import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compileAgentDefinition,
	loadOrganFromPath,
	loadUserOrgansConfig,
	materializeBlueprint,
} from "@dpopsuev/alef-agent-blueprint";
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

function makeDefinition(organs: { name: string; actions?: string[] }[]) {
	return compileAgentDefinition({
		name: "test-agent",
		organs: organs.map((o) => ({
			name: o.name as "fs" | "shell",
			actions: o.actions,
		})),
	});
}

describe("materializeBlueprint", { tags: ["unit"] }, () => {
	it("returns empty organ list when no organs declared", async () => {
		const def = compileAgentDefinition({ name: "empty" });
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(0);
		expect(result.modelId).toBeUndefined();
	});

	it("instantiates FsOrgan for fs organ", async () => {
		const def = makeDefinition([{ name: "fs" }]);
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(1);
		expect(result.organs[0].name).toBe("fs");
	});

	it("instantiates ShellOrgan for shell organ", async () => {
		const def = makeDefinition([{ name: "shell" }]);
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(1);
		expect(result.organs[0].name).toBe("shell");
	});

	it("instantiates both fs and shell", async () => {
		const def = makeDefinition([{ name: "fs" }, { name: "shell" }]);
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(2);
		expect(result.organs.map((o) => o.name)).toEqual(["fs", "shell"]);
	});

	it("lector organ is now supported in the EDA runtime", async () => {
		const def = compileAgentDefinition({
			name: "lector-agent",
			organs: [{ name: "lector" }],
		});
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(1);
		expect(result.organs[0].name).toBe("lector");
	});

	it("skips truly unsupported organs (symbols) without throwing", async () => {
		const def = compileAgentDefinition({
			name: "advanced",
			organs: [{ name: "fs" }, { name: "symbols" }],
		});
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(1);
		expect(result.organs[0].name).toBe("fs");
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

	it("respects action allowlist on fs organ", async () => {
		const def = makeDefinition([{ name: "fs", actions: ["read"] }]);
		const result = await materializeBlueprint(def, { cwd: CWD });
		expect(result.organs).toHaveLength(1);
		const organ = result.organs[0];
		expect(organ.tools.some((t) => t.name === "fs.read")).toBe(true);
		expect(organ.tools.some((t) => t.name === "fs.write")).toBe(false);
	});
});

describe("loadOrganFromPath", { tags: ["unit"] }, () => {
	it("loads a TypeScript organ file and calls createOrgan()", async () => {
		const dir = makeTmp();
		const organFile = join(dir, "my-organ.ts");
		writeFileSync(
			organFile,
			`
import type { Organ } from "@dpopsuev/alef-kernel";
export function createOrgan(_opts: unknown): Organ {
	return {
		name: "my-organ",
		tools: [],
		subscriptions: { motor: [], sense: [] },
		mount: () => () => {},
	};
}
`,
		);
		const organ = await loadOrganFromPath(organFile, { cwd: dir });
		expect(organ.name).toBe("my-organ");
		expect(organ.tools).toHaveLength(0);
	});

	it("throws when file does not export createOrgan", async () => {
		const dir = makeTmp();
		const organFile = join(dir, "bad-organ.ts");
		writeFileSync(organFile, "export const foo = 42;");
		await expect(loadOrganFromPath(organFile, { cwd: dir })).rejects.toThrow("createOrgan");
	});
});

describe("loadUserOrgansConfig", { tags: ["unit"] }, () => {
	it("returns null when organs.yaml does not exist", () => {
		const dir = makeTmp();
		process.env.ALEF_PM_ROOT = dir;
		try {
			expect(loadUserOrgansConfig()).toBeNull();
		} finally {
			delete process.env.ALEF_PM_ROOT;
		}
	});

	it("parses a flat string list", () => {
		const dir = makeTmp();
		writeFileSync(join(dir, "organs.yaml"), "organs:\n  - fs\n  - shell\n");
		process.env.ALEF_PM_ROOT = dir;
		try {
			const result = loadUserOrgansConfig();
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
			join(dir, "organs.yaml"),
			["organs:", "  - name: fs", "    actions: [read]", "  - name: my-organ", "    path: /organs/my-organ.ts"].join(
				"\n",
			),
		);
		process.env.ALEF_PM_ROOT = dir;
		try {
			const result = loadUserOrgansConfig();
			expect(result).toHaveLength(2);
			expect(result?.[0]).toMatchObject({ name: "fs", actions: ["read"] });
			expect(result?.[1]).toMatchObject({ name: "my-organ", path: "/organs/my-organ.ts" });
		} finally {
			delete process.env.ALEF_PM_ROOT;
		}
	});

	it("returns null for a file with no organs key", () => {
		const dir = makeTmp();
		writeFileSync(join(dir, "organs.yaml"), "model: anthropic/claude\n");
		process.env.ALEF_PM_ROOT = dir;
		try {
			expect(loadUserOrgansConfig()).toBeNull();
		} finally {
			delete process.env.ALEF_PM_ROOT;
		}
	});

	it("returns null for an empty file", () => {
		const dir = makeTmp();
		writeFileSync(join(dir, "organs.yaml"), "");
		process.env.ALEF_PM_ROOT = dir;
		try {
			expect(loadUserOrgansConfig()).toBeNull();
		} finally {
			delete process.env.ALEF_PM_ROOT;
		}
	});
});
