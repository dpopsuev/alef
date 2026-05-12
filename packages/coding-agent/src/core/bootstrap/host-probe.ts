import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { statfsSync } from "node:fs";
import os from "node:os";
import type {
	BootstrapCoordinatorId,
	BootstrapHostProbe,
	BootstrapLocalEndpointId,
	BootstrapLocalRuntimeProbe,
	BootstrapOpenAICompatibleEndpoint,
	BootstrapPolicyDecision,
} from "./types.js";

const GIBIBYTE = 1024 ** 3;
const MIN_LOCAL_BOOTSTRAP_MEMORY_BYTES = 8 * GIBIBYTE;
const LARGE_LOCAL_BOOTSTRAP_MEMORY_BYTES = 24 * GIBIBYTE;

const LOCAL_ENDPOINTS: Array<{
	id: BootstrapLocalEndpointId;
	label: string;
	baseUrl: string;
	source: BootstrapOpenAICompatibleEndpoint["source"];
}> = [
	{
		id: "ollama",
		label: "Ollama",
		baseUrl: "http://127.0.0.1:11434/v1",
		source: "managed_runtime",
	},
	{
		id: "lmstudio",
		label: "LM Studio",
		baseUrl: "http://127.0.0.1:1234/v1",
		source: "existing_server",
	},
];

const HIGH_MEMORY_MODEL_PREFERENCES = [
	"qwen2.5:7b",
	"qwen2.5-coder:7b",
	"llama3.1:8b",
	"gpt-oss:20b",
	"qwen2.5:3b",
	"llama3.2:3b",
] as const;

const LOW_MEMORY_MODEL_PREFERENCES = [
	"qwen2.5:3b",
	"llama3.2:3b",
	"qwen2.5:7b",
	"qwen2.5-coder:7b",
	"llama3.1:8b",
	"gpt-oss:20b",
] as const;

export interface ProbeHostBootstrapEnvironmentOptions {
	cwd?: string;
	offlineMode?: boolean;
	fetchImpl?: typeof fetch;
	spawnSyncImpl?: typeof spawnSync;
}

function normalizeLines(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function runCommand(command: string, args: string[], spawnSyncImpl: typeof spawnSync): SpawnSyncReturns<string> {
	return spawnSyncImpl(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function getFreeDiskBytes(cwd: string): number | undefined {
	try {
		const stats = statfsSync(cwd);
		return stats.bavail * stats.bsize;
	} catch {
		return undefined;
	}
}

function detectGpuDescriptions(spawnSyncImpl: typeof spawnSync): string[] {
	const descriptions = new Set<string>();

	const nvidia = runCommand("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], spawnSyncImpl);
	if (nvidia.status === 0) {
		for (const line of normalizeLines(nvidia.stdout)) {
			descriptions.add(line);
		}
	}

	if (process.platform === "darwin") {
		const macGpu = runCommand("system_profiler", ["SPDisplaysDataType"], spawnSyncImpl);
		if (macGpu.status === 0) {
			for (const line of normalizeLines(macGpu.stdout)) {
				if (line.startsWith("Chipset Model:")) {
					descriptions.add(line.replace("Chipset Model:", "").trim());
				}
			}
		}
	}

	if (process.platform === "linux" && descriptions.size === 0) {
		const lspci = runCommand("lspci", [], spawnSyncImpl);
		if (lspci.status === 0) {
			for (const line of normalizeLines(lspci.stdout)) {
				if (/(VGA compatible controller|3D controller|Display controller)/i.test(line)) {
					descriptions.add(line.replace(/^[^:]+:\s*/, "").trim());
				}
			}
		}
	}

	return Array.from(descriptions);
}

function parseEndpointModelIds(payload: unknown): string[] {
	if (!payload || typeof payload !== "object" || !("data" in payload)) {
		return [];
	}

	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) {
		return [];
	}

	return data
		.map((entry) =>
			typeof entry === "object" && entry !== null && "id" in entry ? (entry as { id?: unknown }).id : undefined,
		)
		.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
		.sort((left, right) => left.localeCompare(right));
}

async function probeEndpoint(
	endpoint: (typeof LOCAL_ENDPOINTS)[number],
	fetchImpl: typeof fetch,
): Promise<BootstrapOpenAICompatibleEndpoint> {
	try {
		const response = await fetchImpl(`${endpoint.baseUrl}/models`, {
			signal: AbortSignal.timeout(1500),
		});
		if (!response.ok) {
			return {
				id: endpoint.id,
				label: endpoint.label,
				baseUrl: endpoint.baseUrl,
				reachable: false,
				modelIds: [],
				source: endpoint.source,
			};
		}

		const payload = (await response.json()) as unknown;
		return {
			id: endpoint.id,
			label: endpoint.label,
			baseUrl: endpoint.baseUrl,
			reachable: true,
			modelIds: parseEndpointModelIds(payload),
			source: endpoint.source,
		};
	} catch {
		return {
			id: endpoint.id,
			label: endpoint.label,
			baseUrl: endpoint.baseUrl,
			reachable: false,
			modelIds: [],
			source: endpoint.source,
		};
	}
}

function probeOllamaRuntime(
	endpoint: BootstrapOpenAICompatibleEndpoint | undefined,
	spawnSyncImpl: typeof spawnSync,
): BootstrapLocalRuntimeProbe {
	const versionResult = runCommand("ollama", ["--version"], spawnSyncImpl);
	const installed = versionResult.status === 0;
	let modelIds = endpoint?.modelIds ?? [];

	if (installed && modelIds.length === 0) {
		const listResult = runCommand("ollama", ["list"], spawnSyncImpl);
		if (listResult.status === 0) {
			modelIds = normalizeLines(listResult.stdout)
				.slice(1)
				.map((line) => line.split(/\s+/)[0])
				.filter((id) => id !== undefined && id.length > 0)
				.sort((left, right) => left.localeCompare(right));
		}
	}

	return {
		id: "ollama",
		label: "Ollama",
		installed,
		version: installed ? normalizeLines(versionResult.stdout)[0] : undefined,
		running: endpoint?.reachable ?? false,
		modelIds,
	};
}

async function probeNetworkReachability(fetchImpl: typeof fetch, offlineMode: boolean): Promise<boolean> {
	if (offlineMode) {
		return false;
	}

	try {
		const response = await fetchImpl("https://example.com", {
			method: "HEAD",
			signal: AbortSignal.timeout(1500),
		});
		return response.ok || response.status > 0;
	} catch {
		return false;
	}
}

function getPreferredModelOrder(totalMemoryBytes: number): readonly string[] {
	return totalMemoryBytes >= LARGE_LOCAL_BOOTSTRAP_MEMORY_BYTES
		? HIGH_MEMORY_MODEL_PREFERENCES
		: LOW_MEMORY_MODEL_PREFERENCES;
}

export function recommendLocalBootstrapModelId(totalMemoryBytes: number): string {
	return totalMemoryBytes >= LARGE_LOCAL_BOOTSTRAP_MEMORY_BYTES ? "qwen2.5:7b" : "qwen2.5:3b";
}

export function pickBootstrapModelId(availableModelIds: string[], totalMemoryBytes: number): string | undefined {
	if (availableModelIds.length === 0) {
		return undefined;
	}

	const preferredOrder = getPreferredModelOrder(totalMemoryBytes);
	for (const preferred of preferredOrder) {
		const match = availableModelIds.find((modelId) => modelId.toLowerCase() === preferred.toLowerCase());
		if (match) {
			return match;
		}
	}

	return [...availableModelIds].sort((left, right) => left.localeCompare(right))[0];
}

function recommendCoordinatorId(
	path: BootstrapPolicyDecision["path"],
	totalMemoryBytes: number,
): BootstrapCoordinatorId {
	return path === "local" && totalMemoryBytes < 16 * GIBIBYTE ? "2sec" : "gensec";
}

export async function probeHostBootstrapEnvironment(
	options: ProbeHostBootstrapEnvironmentOptions = {},
): Promise<BootstrapHostProbe> {
	const cwd = options.cwd ?? process.cwd();
	const fetchImpl = options.fetchImpl ?? fetch;
	const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
	const offlineMode = options.offlineMode ?? process.env.ALEF_OFFLINE === "1";

	const endpointResults = await Promise.all(LOCAL_ENDPOINTS.map((endpoint) => probeEndpoint(endpoint, fetchImpl)));
	const ollamaEndpoint = endpointResults.find((endpoint) => endpoint.id === "ollama");
	const runtimes = [probeOllamaRuntime(ollamaEndpoint, spawnSyncImpl)];

	const cpus = os.cpus();
	return {
		collectedAt: new Date().toISOString(),
		hardware: {
			platform: process.platform,
			arch: os.arch(),
			release: os.release(),
			cpuModel: cpus[0]?.model,
			cpuCount: cpus.length,
			totalMemoryBytes: os.totalmem(),
			freeMemoryBytes: os.freemem(),
			freeDiskBytes: getFreeDiskBytes(cwd),
			gpuDescriptions: detectGpuDescriptions(spawnSyncImpl),
			networkReachable: await probeNetworkReachability(fetchImpl, offlineMode),
			offlineMode,
		},
		runtimes,
		endpoints: endpointResults,
	};
}

export function decideBootstrapPolicy(probe: BootstrapHostProbe): BootstrapPolicyDecision {
	const { hardware } = probe;
	const activeEndpoint = probe.endpoints.find((endpoint) => endpoint.reachable && endpoint.modelIds.length > 0);

	if (activeEndpoint) {
		return {
			path: "local",
			rationale: [
				`Detected a working local OpenAI-compatible endpoint at ${activeEndpoint.baseUrl}.`,
				"Using an already-running local model keeps first-run setup deterministic and offline-friendly.",
			],
			recommendedEndpointId: activeEndpoint.id,
			recommendedModelId: pickBootstrapModelId(activeEndpoint.modelIds, hardware.totalMemoryBytes),
			recommendedCoordinatorId: recommendCoordinatorId("local", hardware.totalMemoryBytes),
		};
	}

	const ollamaRuntime = probe.runtimes.find((runtime) => runtime.id === "ollama");
	if (ollamaRuntime?.installed && hardware.totalMemoryBytes >= MIN_LOCAL_BOOTSTRAP_MEMORY_BYTES) {
		return {
			path: "local",
			rationale: [
				"Ollama is installed and the host has enough memory for a small local bootstrap model.",
				"Bootstrap can offer a one-time pull for a lightweight instruct model without committing to it as the permanent default.",
			],
			recommendedEndpointId: "ollama",
			recommendedModelId: recommendLocalBootstrapModelId(hardware.totalMemoryBytes),
			recommendedCoordinatorId: recommendCoordinatorId("local", hardware.totalMemoryBytes),
		};
	}

	const rationale = hardware.offlineMode
		? [
				"Offline mode is enabled and no working local bootstrap endpoint is available yet.",
				"Remote provider login is the only viable path once network access is restored.",
			]
		: [
				"No working local bootstrap endpoint was detected.",
				"Going directly to provider login avoids blocking first-run on local runtime setup.",
			];

	return {
		path: "provider",
		rationale,
		recommendedCoordinatorId: recommendCoordinatorId("provider", hardware.totalMemoryBytes),
	};
}
