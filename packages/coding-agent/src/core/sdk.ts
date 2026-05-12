import { join, resolve } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@dpopsuev/alef-agent-core";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@dpopsuev/alef-ai";
import { APP_NAME, getAgentDir } from "../config.js";
import { AgentSession } from "./agent-session.js";
import { formatNoModelsAvailableMessage } from "./auth-guidance.js";
import { AuthStorage } from "./auth-storage.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.js";
import { convertToLlm } from "./messages.js";
import { ModelRegistry } from "./model-registry.js";
import { findInitialModel } from "./model-resolver.js";
import {
	type AgentDiscoursePort,
	type AgentRole,
	type CompiledAgentDefinition,
	createDefaultDoltStoreDriver,
	findAgentDefinitionPath,
	getCompiledAgentOrgan,
	loadAgentDefinition,
	type ReviewBoardPort,
	SessionBackedDiscourseStore,
	SessionBackedReviewBoard,
	SupervisorManager,
	type WorkingMemoryPort,
} from "./platform/index.js";
import type { ResourceLoader } from "./resource-loader.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { getDefaultSessionDir, SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { isInstallTelemetryEnabled } from "./telemetry.js";
import { time } from "./timings.js";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createSymbolOutlineTool,
	createWriteTool,
	withFileMutationQueue,
} from "./tools/index.js";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory (platform default; Linux uses XDG config home). */
	agentDir?: string;

	/** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (symbol_outline, file_read, file_bash, file_edit, file_write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, pi enables the default built-in tools (symbol_outline, file_read, file_bash, file_edit, file_write)
	 * and leaves extension/custom tools enabled unless `noTools` changes that default.
	 * When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;
	/** Optional agent blueprint path or pre-compiled definition. */
	blueprint?: string | CompiledAgentDefinition;
	/** Platform role for the created runtime. Defaults to root. */
	role?: AgentRole;
	/** Explicit working-memory implementation. */
	workingMemory?: WorkingMemoryPort;
	/** Initial working-memory seed data. */
	workingMemorySeed?: Record<string, unknown>;
	/** Shared discourse/blackboard store. Defaults to a session-backed store. */
	discourse?: AgentDiscoursePort;
	/** Shared review board projection. Defaults to a session-backed store over discourse. */
	review?: ReviewBoardPort;
	/** Optional persistent runtime UUID for child/root budgeting and lifecycle. */
	runtimeId?: string;
	/** Optional discourse object UUID bound to this runtime. */
	discourseObjectId?: string;
	/** Optional topic UUID bound to this runtime. */
	topicId?: string;
	/** Optional thread UUID bound to this runtime. */
	threadId?: string;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.js";
export type {
	AgentTransport,
	TransportExtensionBindings,
} from "./agent-transport.js";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.js";
export { InProcessTransport } from "./in-process-transport.js";
export type { PromptTemplate } from "./prompt-templates.js";
export type { Skill } from "./skills.js";
export type { Tool } from "./tools/index.js";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createSymbolOutlineTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

function getAttributionHeaders(
	model: Model<any>,
	settingsManager: SettingsManager,
): Record<string, string> | undefined {
	if (!isInstallTelemetryEnabled(settingsManager)) {
		return undefined;
	}

	if (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")) {
		return {
			"HTTP-Referer": process.env.ALEF_OPENROUTER_HTTP_REFERER ?? "https://local.invalid",
			"X-OpenRouter-Title": "alef",
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		model.baseUrl.includes("api.cloudflare.com") ||
		model.baseUrl.includes("gateway.ai.cloudflare.com")
	) {
		return {
			"User-Agent": `${APP_NAME}-coding-agent`,
		};
	}

	return undefined;
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@dpopsuev/alef-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: [readTool, bashTool],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd();
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;
	const role = options.role ?? "root";

	// Use provided or create AuthStorage and ModelRegistry
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	const configuredBlueprint = settingsManager.getDefaultBlueprint();
	const blueprintSource = options.blueprint ?? findAgentDefinitionPath(cwd) ?? configuredBlueprint;
	const compiledDefinition =
		typeof blueprintSource === "string"
			? loadAgentDefinition(blueprintSource.startsWith("/") ? blueprintSource : resolve(cwd, blueprintSource))
			: blueprintSource;
	if (role === "child" && getCompiledAgentOrgan(compiledDefinition, "supervisor")) {
		throw new Error("Supervisor organ is only available to root agents.");
	}
	const doltDriver = createDefaultDoltStoreDriver(sessionManager);
	const discourse = options.discourse ?? new SessionBackedDiscourseStore(sessionManager, doltDriver);
	const review = options.review ?? new SessionBackedReviewBoard(sessionManager, discourse, doltDriver);
	for (const policy of settingsManager.getBurnBudgets()) {
		discourse.upsertBudgetPolicy(policy);
	}

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: compiledDefinition?.hooks.extensions,
		});
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	if (!model && compiledDefinition?.model) {
		const blueprintModel = modelRegistry.find(compiledDefinition.model.provider, compiledDefinition.model.id);
		if (!blueprintModel) {
			throw new Error(
				`Blueprint model not found: ${compiledDefinition.model.provider}/${compiledDefinition.model.id}`,
			);
		}
		model = blueprintModel;
	}

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel ?? compiledDefinition?.model?.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames: string[] = [
		"symbol_outline",
		"file_read",
		"file_bash",
		"file_edit",
		"file_write",
		...(role === "root" ? ["supervisor"] : []),
	];
	const blueprintToolNames =
		compiledDefinition && compiledDefinition.capabilities.tools.length > 0
			? [...compiledDefinition.capabilities.tools]
			: undefined;
	if (role === "root" && compiledDefinition?.capabilities.supervisor && blueprintToolNames) {
		if (!blueprintToolNames.includes("supervisor")) {
			blueprintToolNames.push("supervisor");
		}
	}
	const requestedToolNames = options.tools ?? blueprintToolNames;
	const allowedToolNames = requestedToolNames ?? (options.noTools === "all" ? [] : undefined);
	const initialActiveToolNames: string[] = requestedToolNames
		? [...requestedToolNames]
		: options.noTools
			? []
			: defaultActiveToolNames;

	let agent: Agent;
	let session: AgentSession;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const supervisorManager =
		role === "root"
			? new SupervisorManager(async (request) => {
					const childModelSelector = request.definition.model;
					const childModel = childModelSelector
						? modelRegistry.find(childModelSelector.provider, childModelSelector.id)
						: (session?.model ?? model);
					if (childModelSelector && !childModel) {
						throw new Error(`Blueprint model not found: ${childModelSelector.provider}/${childModelSelector.id}`);
					}

					const childSessionManager =
						request.definition.memory.session === "persistent"
							? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir))
							: SessionManager.inMemory(cwd);
					const childResourceLoader = new DefaultResourceLoader({
						cwd,
						agentDir,
						settingsManager,
						additionalExtensionPaths: request.definition.hooks.extensions,
					});
					await childResourceLoader.reload();

					const childResult = await createAgentSession({
						cwd,
						agentDir,
						authStorage,
						modelRegistry,
						model: childModel,
						thinkingLevel: request.definition.model?.thinkingLevel ?? session?.thinkingLevel,
						scopedModels: options.scopedModels,
						tools:
							request.definition.capabilities.tools.length > 0
								? request.definition.capabilities.tools
								: undefined,
						customTools: options.customTools,
						resourceLoader: childResourceLoader,
						sessionManager: childSessionManager,
						settingsManager,
						blueprint: request.definition,
						role: "child",
						workingMemorySeed: request.definition.memory.working,
						discourse,
						review,
						runtimeId: request.runtimeId,
						discourseObjectId: request.discourseObjectId ?? request.topicId ?? request.threadId,
						topicId: request.topicId,
						threadId: request.threadId,
					});
					await childResult.session.bindExtensions({});
					return childResult.session;
				}, discourse)
			: undefined;

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const attributionHeaders = getAttributionHeaders(model, settingsManager);
			return streamSimple(model, context, {
				...options,
				apiKey: auth.apiKey,
				timeoutMs: options?.timeoutMs ?? providerRetrySettings.timeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				headers:
					attributionHeaders || auth.headers || options?.headers
						? { ...attributionHeaders, ...auth.headers, ...options?.headers }
						: undefined,
			});
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
		maxRetries: settingsManager.getProviderRetrySettings().maxRetries,
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRegistry,
		initialActiveToolNames,
		allowedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		role,
		agentDefinition: compiledDefinition,
		workingMemory: options.workingMemory,
		workingMemorySeed: options.workingMemorySeed ?? compiledDefinition?.memory.working,
		discourse,
		review,
		supervisorManager,
		runtimeId: options.runtimeId,
		discourseObjectId: options.discourseObjectId ?? options.topicId ?? options.threadId,
		topicId: options.topicId,
		threadId: options.threadId,
	});
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
