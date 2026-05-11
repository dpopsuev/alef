/**
 * Contract tests — verify InProcessTransport satisfies AgentTransport.
 *
 * These tests prove the transport layer is a faithful delegation wrapper.
 * Every public method/property on AgentTransport must exist on InProcessTransport
 * and must forward calls to AgentSession without modification.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTransport } from "../src/core/agent-transport.js";
import { InProcessTransport } from "../src/core/in-process-transport.js";

// Minimal mock of AgentSession — only the methods InProcessTransport delegates to
function createMockSession() {
	return {
		agent: { signal: undefined, waitForIdle: vi.fn().mockResolvedValue(undefined) },
		state: { systemPrompt: "", model: undefined, thinkingLevel: "off", tools: [], messages: [] },
		messages: [],
		model: undefined,
		thinkingLevel: "off" as const,
		systemPrompt: "",
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		isRetrying: false,
		retryAttempt: 0,
		pendingMessageCount: 0,
		steeringMode: "one-at-a-time" as const,
		followUpMode: "one-at-a-time" as const,
		autoCompactionEnabled: true,
		autoRetryEnabled: true,
		sessionManager: {
			getCwd: vi.fn().mockReturnValue("/tmp"),
			getSessionName: vi.fn(),
			getEntries: vi.fn().mockReturnValue([]),
		},
		settingsManager: {},
		modelRegistry: {
			getAvailable: vi.fn().mockReturnValue([]),
			hasConfiguredAuth: vi.fn(),
			isUsingOAuth: vi.fn(),
			getError: vi.fn(),
		},
		scopedModels: [],
		extensionRunner: { getCommandDiagnostics: vi.fn(), getShortcutDiagnostics: vi.fn(), getMessageRenderer: vi.fn() },
		resourceLoader: {
			getSkills: vi.fn(),
			getPrompts: vi.fn(),
			getThemes: vi.fn(),
			getExtensions: vi.fn().mockReturnValue({ extensions: [], errors: [] }),
			getAgentsFiles: vi.fn(),
		},
		promptTemplates: [],

		// Methods
		prompt: vi.fn().mockResolvedValue(undefined),
		steer: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn(),
		subscribe: vi.fn().mockReturnValue(() => {}),
		setModel: vi.fn().mockResolvedValue(undefined),
		cycleModel: vi.fn().mockResolvedValue(undefined),
		setScopedModels: vi.fn(),
		setThinkingLevel: vi.fn(),
		cycleThinkingLevel: vi.fn().mockReturnValue(undefined),
		getAvailableThinkingLevels: vi.fn().mockReturnValue([]),
		getSteeringMessages: vi.fn().mockReturnValue([]),
		getFollowUpMessages: vi.fn().mockReturnValue([]),
		clearQueue: vi.fn().mockReturnValue({ steering: [], followUp: [] }),
		compact: vi.fn().mockResolvedValue({}),
		abortCompaction: vi.fn(),
		abortBranchSummary: vi.fn(),
		setAutoCompactionEnabled: vi.fn(),
		abortRetry: vi.fn(),
		setAutoRetryEnabled: vi.fn(),
		executeBash: vi.fn().mockResolvedValue({ output: "", exitCode: 0, cancelled: false, truncated: false }),
		recordBashResult: vi.fn(),
		abortBash: vi.fn(),
		setSessionName: vi.fn(),
		getSessionStats: vi.fn().mockReturnValue({}),
		getContextUsage: vi.fn().mockReturnValue(undefined),
		getLastAssistantText: vi.fn().mockReturnValue(undefined),
		getUserMessagesForForking: vi.fn().mockReturnValue([]),
		navigateTree: vi.fn().mockResolvedValue(undefined),
		setSteeringMode: vi.fn(),
		setFollowUpMode: vi.fn(),
		exportToHtml: vi.fn().mockResolvedValue("/tmp/export.html"),
		exportToJsonl: vi.fn().mockReturnValue("/tmp/export.jsonl"),
		getToolDefinition: vi.fn().mockReturnValue(undefined),
		bindExtensions: vi.fn().mockResolvedValue(undefined),
		reload: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn(),
	};
}

describe("InProcessTransport — contract compliance", () => {
	let mock: ReturnType<typeof createMockSession>;
	let transport: AgentTransport;

	beforeEach(() => {
		mock = createMockSession();
		transport = new InProcessTransport(mock as any);
	});

	// =====================================================================
	// Delegation: every method forwards to AgentSession
	// =====================================================================

	it("prompt() delegates to session.prompt()", async () => {
		await transport.prompt("hello", { images: [] });
		expect(mock.prompt).toHaveBeenCalledWith("hello", { images: [] });
	});

	it("steer() delegates to session.steer()", async () => {
		await transport.steer("focus on X");
		expect(mock.steer).toHaveBeenCalledWith("focus on X");
	});

	it("followUp() delegates to session.followUp()", async () => {
		await transport.followUp("next step");
		expect(mock.followUp).toHaveBeenCalledWith("next step");
	});

	it("abort() delegates to session.abort()", () => {
		transport.abort();
		expect(mock.abort).toHaveBeenCalled();
	});

	it("subscribe() delegates and returns unsubscribe", () => {
		const listener = vi.fn();
		const unsub = transport.subscribe(listener);
		expect(mock.subscribe).toHaveBeenCalledWith(listener);
		expect(typeof unsub).toBe("function");
	});

	it("setModel() delegates to session.setModel()", async () => {
		const model = { provider: "test", id: "m1" } as any;
		await transport.setModel(model);
		expect(mock.setModel).toHaveBeenCalledWith(model);
	});

	it("cycleModel() delegates to session.cycleModel()", async () => {
		await transport.cycleModel("forward");
		expect(mock.cycleModel).toHaveBeenCalledWith("forward");
	});

	it("compact() delegates to session.compact()", async () => {
		await transport.compact("focus on errors");
		expect(mock.compact).toHaveBeenCalledWith("focus on errors");
	});

	it("executeBash() delegates all arguments", async () => {
		const onChunk = vi.fn();
		const opts = { excludeFromContext: true };
		await transport.executeBash("ls", onChunk, opts);
		expect(mock.executeBash).toHaveBeenCalledWith("ls", onChunk, opts);
	});

	it("exportToJsonl() delegates and returns string synchronously", () => {
		const result = transport.exportToJsonl("/tmp/out.jsonl");
		expect(mock.exportToJsonl).toHaveBeenCalledWith("/tmp/out.jsonl");
		expect(typeof result).toBe("string");
	});

	it("dispose() delegates to session.dispose()", () => {
		transport.dispose();
		expect(mock.dispose).toHaveBeenCalled();
	});

	// =====================================================================
	// Properties: read-through to session state
	// =====================================================================

	it("isStreaming reads from session", () => {
		expect(transport.isStreaming).toBe(false);
	});

	it("isCompacting reads from session", () => {
		expect(transport.isCompacting).toBe(false);
	});

	it("model reads from session", () => {
		expect(transport.model).toBeUndefined();
	});

	it("thinkingLevel reads from session", () => {
		expect(transport.thinkingLevel).toBe("off");
	});

	it("autoCompactionEnabled reads from session", () => {
		expect(transport.autoCompactionEnabled).toBe(true);
	});

	it("sessionManager reads from session", () => {
		expect(transport.sessionManager).toBe(mock.sessionManager);
	});

	it("modelRegistry reads from session", () => {
		expect(transport.modelRegistry).toBe(mock.modelRegistry);
	});

	it("extensionRunner reads from session", () => {
		expect(transport.extensionRunner).toBe(mock.extensionRunner);
	});

	// =====================================================================
	// setSession: transport can be rebound to a new session
	// =====================================================================

	it("setSession() switches the underlying session", async () => {
		const mock2 = createMockSession();
		(transport as InProcessTransport).setSession(mock2 as any);

		await transport.prompt("after rebind");
		expect(mock.prompt).not.toHaveBeenCalled();
		expect(mock2.prompt).toHaveBeenCalledWith("after rebind", undefined);
	});
});
