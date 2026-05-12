import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ensureBootstrapBlueprints } from "../src/core/bootstrap/blueprints.js";
import { decideBootstrapPolicy } from "../src/core/bootstrap/host-probe.js";
import {
	buildBootstrapLocalProviderSelection,
	upsertBootstrapLocalProviderConfig,
} from "../src/core/bootstrap/local-models.js";
import type { BootstrapHostProbe } from "../src/core/bootstrap/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { BUILTIN_OPERATOR_COMMANDS } from "../src/core/symbolic-commands.js";

const tempDirs: string[] = [];

interface BootstrapProbeOverrides {
	collectedAt?: string;
	hardware?: Partial<BootstrapHostProbe["hardware"]>;
	runtimes?: BootstrapHostProbe["runtimes"];
	endpoints?: BootstrapHostProbe["endpoints"];
}

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createProbe(overrides: BootstrapProbeOverrides = {}): BootstrapHostProbe {
	const runtimes: BootstrapHostProbe["runtimes"] = [
		{
			id: "ollama",
			label: "Ollama",
			installed: true,
			version: "ollama version 0.1.0",
			running: true,
			modelIds: ["qwen2.5:7b"],
		},
		...(overrides.runtimes ?? []).filter((runtime) => runtime.id !== "ollama"),
	];

	const baseEndpoints: BootstrapHostProbe["endpoints"] = [
		{
			id: "ollama",
			label: "Ollama",
			baseUrl: "http://127.0.0.1:11434/v1",
			reachable: true,
			modelIds: ["qwen2.5:7b"],
			source: "managed_runtime",
		},
		{
			id: "lmstudio",
			label: "LM Studio",
			baseUrl: "http://127.0.0.1:1234/v1",
			reachable: false,
			modelIds: [],
			source: "existing_server",
		},
	];
	const endpoints: BootstrapHostProbe["endpoints"] = baseEndpoints.map(
		(endpoint): BootstrapHostProbe["endpoints"][number] => {
			const override = overrides.endpoints?.find((candidate) => candidate.id === endpoint.id);
			return override ? { ...endpoint, ...override } : endpoint;
		},
	);

	return {
		collectedAt: overrides.collectedAt ?? "2026-05-11T16:00:00.000Z",
		hardware: {
			platform: "linux",
			arch: "x64",
			release: "6.0.0",
			cpuModel: "Test CPU",
			cpuCount: 8,
			totalMemoryBytes: 32 * 1024 ** 3,
			freeMemoryBytes: 24 * 1024 ** 3,
			freeDiskBytes: 200 * 1024 ** 3,
			gpuDescriptions: ["Test GPU"],
			networkReachable: true,
			offlineMode: false,
			...(overrides.hardware ?? {}),
		},
		runtimes,
		endpoints,
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("bootstrap coolstart core", () => {
	it("prefers an already-running local endpoint over direct provider login", () => {
		const policy = decideBootstrapPolicy(createProbe());

		expect(policy.path).toBe("local");
		expect(policy.recommendedEndpointId).toBe("ollama");
		expect(policy.recommendedModelId).toBe("qwen2.5:7b");
		expect(policy.recommendedCoordinatorId).toBe("gensec");
	});

	it("recommends provider login when no local bootstrap path is viable", () => {
		const policy = decideBootstrapPolicy(
			createProbe({
				hardware: {
					totalMemoryBytes: 4 * 1024 ** 3,
					freeMemoryBytes: 3 * 1024 ** 3,
				},
				runtimes: [
					{
						id: "ollama",
						label: "Ollama",
						installed: false,
						running: false,
						modelIds: [],
					},
				],
				endpoints: [
					{
						id: "ollama",
						label: "Ollama",
						baseUrl: "http://127.0.0.1:11434/v1",
						reachable: false,
						modelIds: [],
						source: "managed_runtime",
					},
					{
						id: "lmstudio",
						label: "LM Studio",
						baseUrl: "http://127.0.0.1:1234/v1",
						reachable: false,
						modelIds: [],
						source: "existing_server",
					},
				],
			}),
		);

		expect(policy.path).toBe("provider");
		expect(policy.recommendedCoordinatorId).toBe("gensec");
	});

	it("writes a local bootstrap provider into models.json without dropping existing providers", () => {
		const dir = makeTempDir("alef-bootstrap-models-");
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify(
				{
					providers: {
						existing: {
							baseUrl: "https://example.com/v1",
							api: "openai-completions",
							apiKey: "EXISTING_API_KEY",
							models: [{ id: "existing-model" }],
						},
					},
				},
				null,
				2,
			),
		);

		const selection = buildBootstrapLocalProviderSelection(
			{
				id: "ollama",
				label: "Ollama",
				baseUrl: "http://127.0.0.1:11434/v1",
				reachable: true,
				modelIds: ["qwen2.5:3b"],
				source: "managed_runtime",
			},
			"qwen2.5:3b",
		);
		upsertBootstrapLocalProviderConfig(modelsPath, selection);

		const parsed = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
			providers: Record<string, { baseUrl?: string; models?: Array<{ id: string }> }>;
		};
		expect(parsed.providers.existing?.baseUrl).toBe("https://example.com/v1");
		expect(parsed.providers["local-ollama"]?.baseUrl).toBe("http://127.0.0.1:11434/v1");
		expect(parsed.providers["local-ollama"]?.models?.map((model) => model.id)).toEqual(["qwen2.5:3b"]);
	});

	it("materializes shipped GenSec and 2Sec blueprints into the agent directory", () => {
		const agentDir = makeTempDir("alef-bootstrap-agent-");

		const blueprints = ensureBootstrapBlueprints(agentDir);
		const gensecYaml = readFileSync(blueprints.entries.gensec.targetPath, "utf-8");
		const secondSecYaml = readFileSync(blueprints.entries["2sec"].targetPath, "utf-8");

		expect(gensecYaml).toContain("name: gensec");
		expect(gensecYaml).toContain("blueprint: ./2sec.yaml");
		expect(secondSecYaml).toContain("name: 2sec");
	});

	it("registers a rerunnable bootstrap operator command", () => {
		const command = BUILTIN_OPERATOR_COMMANDS.find((entry) => entry.name === "bootstrap");
		expect(command?.aliases).toContain("coolstart");
	});

	it("uses the configured default blueprint when creating a new session", async () => {
		const projectDir = makeTempDir("alef-bootstrap-project-");
		const agentDir = makeTempDir("alef-bootstrap-config-");
		const blueprintPath = join(agentDir, "gensec.yaml");
		writeFileSync(
			blueprintPath,
			[
				"name: bootstrap-root",
				"systemPrompt: |",
				"  Bootstrap root blueprint.",
				"organs:",
				"  - name: fs",
				"    actions:",
				"      - read",
				"memory:",
				"  session: memory",
			].join("\n"),
		);

		const settingsManager = SettingsManager.inMemory({
			defaultBlueprint: blueprintPath,
		});
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const model = modelRegistry.getAll()[0];
		expect(model).toBeDefined();

		const sessionManager = SessionManager.inMemory(projectDir);
		const created = await createAgentSession({
			cwd: projectDir,
			agentDir,
			settingsManager,
			authStorage,
			modelRegistry,
			sessionManager,
			model: model!,
		});

		expect(created.session.agentDefinition?.name).toBe("bootstrap-root");
		expect(created.session.agentDefinition?.sourcePath).toBe(blueprintPath);
		created.session.dispose();
	});
});
