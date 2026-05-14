import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runtimeBoardExports from "@dpopsuev/alef-agent-runtime/board";
import * as runtimePlatformExports from "@dpopsuev/alef-agent-runtime/platform";
import { afterEach, describe, expect, it } from "vitest";
import * as blueprintExports from "../../blueprint/src/index.js";
import * as discourseExports from "../../discourse/src/index.js";
import * as organAiExports from "../../organ-ai/src/index.js";
import * as organDialogExports from "../../organ-dialog/src/index.js";
import * as organMonologExports from "../../organ-monolog/src/index.js";
import * as runtimeExports from "../../runtime/src/index.js";
import * as nerveExports from "../../spine/src/index.js";
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

	it("parses CRD-style agent resources with metadata and dependencies", () => {
		const definition = blueprintExports.parseAgentDefinitionYaml(`
apiVersion: alef.dpopsuev.io/v1alpha1
kind: AgentRuntime
metadata:
  name: resource-reviewer
  labels:
    lane: release
spec:
  organs:
    - name: fs
      actions:
        - read
  dependencies:
    packages:
      - source: ./extensions/pkg
        extensions:
          - extensions/*.ts
    prompts:
      - ./.alef/prompts/release.md
`);

		expect(definition.name).toBe("resource-reviewer");
		expect(definition.resource).toEqual({
			apiVersion: "alef.dpopsuev.io/v1alpha1",
			kind: "AgentRuntime",
			metadata: {
				name: "resource-reviewer",
				labels: {
					lane: "release",
				},
				annotations: {},
			},
		});
		expect(definition.dependencies).toEqual({
			packages: [
				{
					source: "./extensions/pkg",
					extensions: ["extensions/*.ts"],
				},
			],
			extensions: [],
			skills: [],
			prompts: ["./.alef/prompts/release.md"],
			themes: [],
		});
	});

	it("requires explicit supervisor capability in blueprint compilation", () => {
		expect(() =>
			blueprintExports.compileAgentDefinition({
				name: "missing-supervisor-capability",
				organs: [{ name: "supervisor" }],
			}),
		).toThrow("supervisor organ requires capabilities.supervisor: true");

		expect(() =>
			blueprintExports.compileAgentDefinition({
				name: "missing-supervisor-organ",
				capabilities: { supervisor: true },
			}),
		).toThrow("capabilities.supervisor: true requires a supervisor organ");

		const definition = blueprintExports.compileAgentDefinition({
			name: "explicit-supervisor",
			organs: [{ name: "supervisor" }],
			capabilities: { supervisor: true },
		});
		expect(definition.capabilities.supervisor).toBe(true);
		expect(definition.capabilities.tools).toContain("supervisor");
	});

	it("compiles optional loop and delegation blueprint policies", () => {
		const definition = blueprintExports.compileAgentDefinition({
			name: "policy-aware",
			organs: [{ name: "fs", actions: ["read"] }],
			loop: {
				strategy: "minimal",
				steeringMode: "all",
				followUpMode: "all",
				toolExecution: "parallel",
				maxTurnsPerRun: 3,
				stopOnBudgetAction: "warn",
				ablation: {
					disableSteering: true,
				},
			},
			delegation: {
				mode: "manual",
			},
		});

		expect(definition.loop).toEqual({
			strategy: "minimal",
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "parallel",
			maxTurnsPerRun: 3,
			stopOnBudgetAction: "warn",
			ablation: {
				disableSteering: true,
				disableFollowUp: false,
				forceSequentialTools: false,
			},
		});
		expect(definition.delegation).toEqual({ mode: "manual" });
	});

	it("materializes shipped bootstrap blueprints from the blueprint package", () => {
		const agentDir = makeTempDir("alef-blueprint-split-");
		const materialized = blueprintExports.ensureBootstrapBlueprints(agentDir);
		const primordialYaml = readFileSync(materialized.entries.primordial.targetPath, "utf-8");
		const gensecYaml = readFileSync(materialized.entries.gensec.targetPath, "utf-8");
		const secondSecYaml = readFileSync(materialized.entries["2sec"].targetPath, "utf-8");

		expect(primordialYaml).toContain("name: primordial");
		expect(gensecYaml).toContain("name: gensec");
		expect(secondSecYaml).toContain("name: 2sec");
	});

	it("exposes runtime board/platform primitives through the dedicated runtime package", () => {
		expect(typeof runtimeExports.InMemoryBoard).toBe("function");
		expect(typeof runtimeExports.PlatformActionRegistry).toBe("function");
		expect(typeof runtimeExports.InMemoryDoltStoreDriver).toBe("function");
		expect(typeof runtimeExports.composeRuntime).toBe("function");
		expect(typeof runtimeExports.bootstrapLifecycle).toBe("function");
	});

	it("exports coding-agent runtime APIs from the CLI package entrypoint", () => {
		expect(typeof codingAgentExports.createAgentSession).toBe("function");
		expect(typeof codingAgentExports.createAgentSessionRuntime).toBe("function");
		expect(typeof codingAgentExports.SessionManager).toBe("function");
		expect(typeof codingAgentExports.SettingsManager).toBe("function");
		expect(typeof codingAgentExports.AuthStorage).toBe("function");
		expect(typeof codingAgentExports.main).toBe("function");
		expect(typeof codingAgentExports.runYamlRunner).toBe("function");
		expect(typeof codingAgentExports.InteractiveMode).toBe("function");
	});

	it("uses nerve as canonical contract owner", () => {
		expect(typeof nerveExports.RuntimeDomainEventSpine).toBe("function");
		expect(typeof nerveExports.MemLog).toBe("function");
		expect(typeof nerveExports.validateProtocolEvent).toBe("function");
		expect(codingAgentBoardExports.MemLog).toBe(runtimeBoardExports.MemLog);
	});

	it("exposes the merged organ-ai surface", () => {
		expect(typeof organAiExports.createCompleterOrganAdapter).toBe("function");
		expect(typeof organAiExports.streamSimple).toBe("function");
	});

	it("exposes discourse library and explicit dialog/monolog organs", () => {
		expect(typeof discourseExports.createDiscourseOrganPorts).toBe("function");
		expect(typeof discourseExports.asAgentDiscoursePort).toBe("function");
		expect(typeof organDialogExports.createDialogDiscoursePort).toBe("function");
		expect(typeof organMonologExports.createMonologDiscoursePort).toBe("function");
		expect(typeof codingAgentPlatformExports.createDialogDiscoursePort).toBe("function");
		expect(typeof codingAgentPlatformExports.createMonologDiscoursePort).toBe("function");
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
