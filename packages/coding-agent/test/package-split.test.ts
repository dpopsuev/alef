import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runtimeBoardExports from "@dpopsuev/alef-agent-runtime/board";
import * as runtimePlatformExports from "@dpopsuev/alef-agent-runtime/platform";
import { afterEach, describe, expect, it } from "vitest";
import * as blueprintExports from "../../blueprint/src/index.js";
import * as runtimeExports from "../../runtime/src/index.js";
import * as codingAgentBoardExports from "../src/board/index.js";
import * as codingAgentPlatformExports from "../src/core/platform/index.js";
import * as codingAgentExports from "../src/index.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("package split surfaces", () => {
	it("compiles agent blueprints from the dedicated blueprint package", () => {
		const definition = blueprintExports.compileAgentDefinition({
			name: "split-test",
			organs: [{ name: "fs", actions: ["read", "write"] }],
		});

		expect(definition.name).toBe("split-test");
		expect(definition.organs).toEqual([
			{
				name: "fs",
				actions: ["read", "write"],
				toolNames: ["file_read", "file_write"],
			},
		]);
	});

	it("materializes shipped bootstrap blueprints from the blueprint package", () => {
		const agentDir = makeTempDir("alef-blueprint-split-");
		const materialized = blueprintExports.ensureBootstrapBlueprints(agentDir);
		const gensecYaml = readFileSync(materialized.entries.gensec.targetPath, "utf-8");
		const secondSecYaml = readFileSync(materialized.entries["2sec"].targetPath, "utf-8");

		expect(gensecYaml).toContain("name: gensec");
		expect(secondSecYaml).toContain("name: 2sec");
	});

	it("exposes runtime services through the dedicated runtime package", () => {
		expect(typeof runtimeExports.createAgentSession).toBe("function");
		expect(typeof runtimeExports.createAgentSessionRuntime).toBe("function");
		expect(typeof runtimeExports.SessionManager).toBe("function");
		expect(typeof runtimeExports.SettingsManager).toBe("function");
		expect(typeof runtimeExports.AuthStorage).toBe("function");
		expect(typeof runtimeExports.runRpcMode).toBe("function");
	});

	it("re-exports runtime APIs from the CLI package for compatibility", () => {
		expect(codingAgentExports.createAgentSession).toBe(runtimeExports.createAgentSession);
		expect(codingAgentExports.SessionManager).toBe(runtimeExports.SessionManager);
		expect(codingAgentExports.SettingsManager).toBe(runtimeExports.SettingsManager);
		expect(codingAgentExports.AuthStorage).toBe(runtimeExports.AuthStorage);
		expect(typeof codingAgentExports.main).toBe("function");
		expect(typeof codingAgentExports.InteractiveMode).toBe("function");
	});

	it("exposes board primitives from the runtime board subpath and preserves board wrappers", () => {
		expect(typeof runtimeBoardExports.InMemoryBoard).toBe("function");
		expect(typeof runtimeBoardExports.boardPathToAddress).toBe("function");
		expect(codingAgentBoardExports.InMemoryBoard).toBe(runtimeBoardExports.InMemoryBoard);
		expect(codingAgentBoardExports.GeneralSecretary).toBe(runtimeBoardExports.GeneralSecretary);
		expect(codingAgentBoardExports.boardPathToAddress).toBe(runtimeBoardExports.boardPathToAddress);
	});

	it("exposes platform foundation primitives from the runtime platform subpath", () => {
		expect(typeof runtimePlatformExports.PlatformActionRegistry).toBe("function");
		expect(typeof runtimePlatformExports.InMemoryWorkingMemoryPort).toBe("function");
		expect(typeof runtimePlatformExports.DiscourseScheduler).toBe("function");
		expect(typeof runtimePlatformExports.InMemoryDoltStoreDriver).toBe("function");
		expect(codingAgentPlatformExports.PlatformActionRegistry).toBe(runtimePlatformExports.PlatformActionRegistry);
		expect(codingAgentPlatformExports.InMemoryWorkingMemoryPort).toBe(
			runtimePlatformExports.InMemoryWorkingMemoryPort,
		);
		expect(codingAgentPlatformExports.DiscourseScheduler).toBe(runtimePlatformExports.DiscourseScheduler);
		expect(codingAgentPlatformExports.InMemoryDoltStoreDriver).toBe(runtimePlatformExports.InMemoryDoltStoreDriver);
	});
});
