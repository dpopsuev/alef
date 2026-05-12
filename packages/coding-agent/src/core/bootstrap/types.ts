export type BootstrapRecommendationPath = "local" | "provider";

export type BootstrapOutcome = "local" | "provider" | "hybrid" | "skipped";

export type BootstrapCoordinatorId = "gensec" | "2sec";

export type BootstrapLocalEndpointId = "ollama" | "lmstudio";

export interface BootstrapHardwareProfile {
	platform: NodeJS.Platform;
	arch: string;
	release: string;
	cpuModel?: string;
	cpuCount: number;
	totalMemoryBytes: number;
	freeMemoryBytes: number;
	freeDiskBytes?: number;
	gpuDescriptions: string[];
	networkReachable: boolean;
	offlineMode: boolean;
}

export interface BootstrapLocalRuntimeProbe {
	id: "ollama";
	label: string;
	installed: boolean;
	version?: string;
	running: boolean;
	modelIds: string[];
}

export interface BootstrapOpenAICompatibleEndpoint {
	id: BootstrapLocalEndpointId;
	label: string;
	baseUrl: string;
	reachable: boolean;
	modelIds: string[];
	source: "existing_server" | "managed_runtime";
}

export interface BootstrapHostProbe {
	collectedAt: string;
	hardware: BootstrapHardwareProfile;
	runtimes: BootstrapLocalRuntimeProbe[];
	endpoints: BootstrapOpenAICompatibleEndpoint[];
}

export interface BootstrapPolicyDecision {
	path: BootstrapRecommendationPath;
	rationale: string[];
	recommendedEndpointId?: BootstrapLocalEndpointId;
	recommendedModelId?: string;
	recommendedCoordinatorId: BootstrapCoordinatorId;
}

export interface BootstrapPersistedProviderSelection {
	providerId: string;
	modelId?: string;
	baseUrl?: string;
}

export interface BootstrapState {
	lastRunAt?: string;
	completedAt?: string;
	outcome?: BootstrapOutcome;
	hostProbe?: BootstrapHostProbe;
	recommendation?: BootstrapPolicyDecision;
	coordinatorBlueprint?: string;
	localFallback?: BootstrapPersistedProviderSelection;
	durableProvider?: BootstrapPersistedProviderSelection;
}
