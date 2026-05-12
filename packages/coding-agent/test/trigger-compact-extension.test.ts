import { describe, expect, test, vi } from "vitest";
import triggerCompactExtension from "../examples/extensions/trigger-compact.js";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/index.js";

function createContext(tokens: number | null, compact = vi.fn()): ExtensionContext {
	return {
		hasUI: false,
		ui: {} as ExtensionContext["ui"],
		cwd: process.cwd(),
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		platform: {
			role: "root",
			memory: {
				session: {
					getMessages: () => [],
					getEntries: () => [],
					buildContext: () => ({ messages: [], thinkingLevel: "off", model: null }),
					getSessionId: () => "test-session",
					getSessionFile: () => undefined,
				},
				working: {
					get: () => undefined,
					set: () => {},
					delete: () => false,
					clear: () => {},
					list: () => [],
					snapshot: () => ({}),
				},
			},
			discourse: {
				ensureBoard: () => {
					throw new Error("not implemented");
				},
				ensureForum: () => {
					throw new Error("not implemented");
				},
				createTemplate: () => {
					throw new Error("not implemented");
				},
				createContract: () => {
					throw new Error("not implemented");
				},
				approveTemplate: () => {
					throw new Error("not implemented");
				},
				approveContract: () => {
					throw new Error("not implemented");
				},
				rejectTemplate: () => {
					throw new Error("not implemented");
				},
				rejectContract: () => {
					throw new Error("not implemented");
				},
				createTopic: () => {
					throw new Error("not implemented");
				},
				relocateTopic: () => {
					throw new Error("not implemented");
				},
				assignTopic: () => {
					throw new Error("not implemented");
				},
				updateTopic: () => {
					throw new Error("not implemented");
				},
				postLetter: () => {
					throw new Error("not implemented");
				},
				postOperatorLetter: () => {
					throw new Error("not implemented");
				},
				claimTarget: () => {
					throw new Error("not implemented");
				},
				renewClaim: () => {
					throw new Error("not implemented");
				},
				releaseClaim: () => {
					throw new Error("not implemented");
				},
				listClaims: () => [],
				expireClaims: () => [],
				requestStamp: () => {
					throw new Error("not implemented");
				},
				decideStamp: () => {
					throw new Error("not implemented");
				},
				listStamps: () => [],
				listBoards: () => [],
				listForums: () => [],
				listTemplates: () => [],
				listContracts: () => [],
				listTopics: () => [],
				readThread: () => {
					throw new Error("not implemented");
				},
				archiveTopic: () => {
					throw new Error("not implemented");
				},
				registerRuntime: () => {
					throw new Error("not implemented");
				},
				updateRuntime: () => {
					throw new Error("not implemented");
				},
				listRuntimes: () => [],
				getRuntime: () => undefined,
				createKnowledgeAtom: () => {
					throw new Error("not implemented");
				},
				createKnowledgeMolecule: () => {
					throw new Error("not implemented");
				},
				listKnowledgeAtoms: () => [],
				listKnowledgeMolecules: () => [],
				upsertBudgetPolicy: () => {
					throw new Error("not implemented");
				},
				listBudgetPolicies: () => [],
				recordBudgetUsage: () => [],
				readBudgetStatus: () => [],
				listBudgetLedger: () => [],
				getAgentCapacity: () => ({
					id: "global",
					maxConcurrent: 1,
					activeRuntimeIds: [],
					updatedAt: 0,
				}),
				setAgentCapacity: () => ({
					id: "global",
					maxConcurrent: 1,
					activeRuntimeIds: [],
					updatedAt: 0,
				}),
				getBoard: () => undefined,
				getForum: () => undefined,
				getTemplate: () => undefined,
				getContract: () => undefined,
				getTopic: () => undefined,
				getTopicByAddress: () => undefined,
				getThread: () => undefined,
				getThreadByAddress: () => undefined,
			},
			review: {
				listDocuments: () => [],
				getDocument: () => undefined,
				getDocumentByAddress: () => undefined,
				addComment: () => {
					throw new Error("not implemented");
				},
			},
			actions: [],
			getAction: () => undefined,
			getCapabilities: () => [],
		},
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: tokens === null ? null : tokens / 2000 }),
		compact,
		getSystemPrompt: () => "",
	};
}

describe("trigger-compact example extension", () => {
	test("only auto-compacts when context usage crosses the threshold", () => {
		let turnEndHandler:
			| ((event: { type: "turn_end" }, ctx: ExtensionContext | ExtensionCommandContext) => void)
			| undefined;

		const api = {
			on: (event: string, handler: (event: { type: "turn_end" }, ctx: ExtensionContext) => void) => {
				if (event === "turn_end") {
					turnEndHandler = handler;
				}
			},
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;

		triggerCompactExtension(api);
		expect(turnEndHandler).toBeDefined();

		const compact = vi.fn();
		const event = { type: "turn_end" } as const;

		turnEndHandler?.(event, createContext(110_000, compact));
		expect(compact).not.toHaveBeenCalled();

		turnEndHandler?.(event, createContext(120_000, compact));
		expect(compact).not.toHaveBeenCalled();

		turnEndHandler?.(event, createContext(95_000, compact));
		expect(compact).not.toHaveBeenCalled();

		turnEndHandler?.(event, createContext(105_000, compact));
		expect(compact).toHaveBeenCalledTimes(1);
	});
});
