import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { createContextAssembler } from "@dpopsuev/alef-kernel/context-assembly";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompactionStage } from "../../session/src/context/compaction.js";
import { hashRecord, type SessionStore, type StorageRecord } from "../../session/src/contracts/storage.js";
import { BusFixture, TurnDriver } from "../../testkit/src/index.js";
import { createAgentLoop } from "../src/index.js";

const OVERFLOW_ERROR = "prompt is too long: 213462 tokens > 200000 maximum";

function extractTextContent(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block?.type === "text" ? (block.text ?? "") : "")).join("");
}

describe("Reasoner — context overflow recovery", { tags: ["unit"] }, () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	function makeMemorySessionStore() {
		const records: StorageRecord[] = [];
		const store: SessionStore = {
			id: "overflow-test",
			path: "/tmp/overflow-test",
			async append(record) {
				records.push({ ...record, hash: hashRecord(record) });
			},
			async events() {
				return [...records];
			},
			async turns() {
				return [];
			},
			async hitCounts() {
				return new Map();
			},
			async adapterHistory() {
				return [];
			},
			name: () => undefined,
			nameSource: () => undefined,
			async setName() {},
			tags: () => [],
			tagsSource: () => undefined,
			async setTags() {},
			searchBlob: () => undefined,
			async setSearchBlob() {},
			async isEmpty() {
				return records.length === 0;
			},
			async destroy() {},
		};
		return { store, records };
	}

	function makeOverflowHarness(
		faux: ReturnType<typeof registerFauxProvider>,
		opts?: { realCompactor?: boolean; summarize?: () => Promise<string> | string },
	) {
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		const recorder = f.observe();
		const compactRequests: Array<Record<string, unknown>> = [];
		const overflowSignals: Array<Record<string, unknown>> = [];
		const compactingSignals: Array<Record<string, unknown>> = [];
		const compactedSignals: Array<Record<string, unknown>> = [];
		const assembledMessages: unknown[][] = [];
		const { store, records } = makeMemorySessionStore();
		let pendingForceCompact: { instructions?: string; strategy?: "shake" | "summarize" } | undefined;
		let lastTotalTokens = 0;
		let signalPublish: ((type: string, payload: Record<string, unknown>) => void) | undefined;

		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				phaseTimeoutMs: 500,
				maxRetryDelayMs: 0,
			}),
		);

		if (opts?.realCompactor) {
			const assembler = createContextAssembler();
			assembler.addStage("seed-history", async ({ messages }) => ({
				messages: [
					{ role: "user", content: [{ type: "text", text: "older prompt" }], timestamp: 1 },
					fauxAssistantMessage("older answer"),
					...messages,
				],
			}));
			assembler.addStage(
				"compactor",
				createCompactionStage({
					contextWindow: 200_000,
					keepRecentTokens: 20_000,
					reserveTokens: 16_384,
					getLastTokenCount: () => lastTotalTokens,
					summarize: opts.summarize ?? (async () => "SUM: compacted context"),
					sessionStore: () => store,
					publishSignal: (type, payload) => {
						signalPublish?.(type, payload);
					},
					pullForceCompact: () => {
						const force = pendingForceCompact;
						pendingForceCompact = undefined;
						return force;
					},
				}),
			);
			const origMount = assembler.mount.bind(assembler);
			(assembler as { mount: typeof assembler.mount }).mount = (bus) => {
				signalPublish = (type, payload) => {
					bus.notification.publish({ type, payload, correlationId: "" });
				};
				bus.notification.subscribe("llm.token-usage", (event) => {
					const usage = (event as { payload?: { usage?: { totalTokens?: number } } }).payload?.usage;
					if (usage?.totalTokens) lastTotalTokens = usage.totalTokens;
				});
				bus.notification.subscribe("context.compacted", (event) => {
					const after = (event as { payload?: { estimatedAfter?: number } }).payload?.estimatedAfter;
					if (typeof after === "number" && after >= 0) lastTotalTokens = after;
				});
				bus.notification.subscribe("context.compact.request", (event) => {
					const payload = event.payload as Record<string, unknown>;
					compactRequests.push(payload);
					const strategy = payload.strategy;
					pendingForceCompact = {
						instructions: typeof payload.instructions === "string" ? payload.instructions : undefined,
						strategy: strategy === "shake" || strategy === "summarize" ? strategy : undefined,
					};
				});
				bus.notification.subscribe("context.overflow-recovery", (event) => {
					overflowSignals.push(event.payload as Record<string, unknown>);
				});
				bus.notification.subscribe("context.compacting", (event) => {
					compactingSignals.push(event.payload as Record<string, unknown>);
				});
				bus.notification.subscribe("context.compacted", (event) => {
					compactedSignals.push(event.payload as Record<string, unknown>);
				});
				bus.notification.subscribe("context.injection", (event) => {
					void event;
				});
				bus.event.subscribe("context.assemble", (event) => {
					const payload = event.payload as { messages?: unknown[] };
					if (Array.isArray(payload.messages)) assembledMessages.push(payload.messages);
				});
				return origMount(bus);
			};
			f.mount(assembler);
		} else {
			const phaseAdapter = {
				name: "overflow-phase",
				description: "immediate assemble reply for overflow recovery tests",
				labels: [] as const,
				tools: [] as const,
				publishSchemas: {} as const,
				subscriptions: { command: ["context.assemble"] as const, event: [] as const, notification: [] as const },
				sources: [],
				mount(nerve: Bus) {
					nerve.command.subscribe("context.assemble", (event) => {
						nerve.event.publish({
							type: "context.assemble",
							payload: { messages: (event.payload as { messages: unknown[] }).messages },
							correlationId: event.correlationId,
							isError: false,
						});
					});
					nerve.notification.subscribe("context.compact.request", (event) => {
						compactRequests.push(event.payload as Record<string, unknown>);
					});
					nerve.notification.subscribe("context.overflow-recovery", (event) => {
						overflowSignals.push(event.payload as Record<string, unknown>);
					});
					return () => {};
				},
			};
			f.mount(phaseAdapter);
		}
		disposes.push(() => f.dispose());

		return {
			driver,
			recorder,
			compactRequests,
			overflowSignals,
			compactingSignals,
			compactedSignals,
			assembledMessages,
			storeRecords: records,
		};
	}

	it("force-compacts once and retries LLM on context overflow", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_ERROR }),
			fauxAssistantMessage("recovered after compact"),
		]);
		const { driver, compactRequests, overflowSignals } = makeOverflowHarness(faux);

		const reply = await driver.send("hi", "user", 5_000);

		expect(reply).toBe("recovered after compact");
		expect(faux.state.callCount).toBe(2);
		expect(compactRequests).toHaveLength(1);
		expect(typeof compactRequests[0]?.instructions).toBe("string");
		expect(overflowSignals).toEqual(
			expect.arrayContaining([expect.objectContaining({ willRetry: true })]),
		);
		expect(overflowSignals.some((signal) => signal.willRetry === false)).toBe(false);
	});

	it("escalates through three recovery stages then fails", async () => {
		const faux = registerFauxProvider();
		// Overflow on all attempts through all stages
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_ERROR }), // Stage 1: Standard
			fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_ERROR }), // Stage 2: Aggressive
			fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_ERROR }), // Stage 3: ArgTruncation
			fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_ERROR }), // Stage 4: Emergency - after this, no more retries
			fauxAssistantMessage("should never be reached"),
		]);
		const { driver, compactRequests, overflowSignals } = makeOverflowHarness(faux);

		const reply = await driver.send("hi", "user", 5_000);

		// Four LLM attempts (one per stage)
		expect(faux.state.callCount).toBe(4);

		// Only Standard and Aggressive stages request compaction
		expect(compactRequests).toHaveLength(2);

		// Three willRetry: true signals (stages 1-3), then one final willRetry: false after stage 4
		// Emergency stage (4) attempts but doesn't escalate further, so no willRetry signal before failure
		expect(overflowSignals.filter((signal) => signal.willRetry === true)).toHaveLength(3);
		expect(overflowSignals.filter((signal) => signal.willRetry === false)).toHaveLength(1);

		// Final reply should contain the error
		expect(reply).toContain("prompt is too long");
		expect(reply).not.toBe("should never be reached");
	});

	it("runs a real compaction stage before retrying after overflow", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_ERROR }),
			fauxAssistantMessage("recovered after compact"),
		]);
		const {
			driver,
			compactRequests,
			overflowSignals,
			compactingSignals,
			compactedSignals,
			assembledMessages,
			storeRecords,
		} = makeOverflowHarness(faux, {
			realCompactor: true,
			summarize: () =>
				new Promise<string>((resolve) => {
					releaseCompaction = () => resolve("SUM: compacted context");
				}),
		});
		let releaseCompaction!: () => void;

		const replyPromise = driver.send("trigger overflow", "user", 5_000);
		await vi.waitFor(() => {
			expect(compactingSignals).toEqual([{ active: true }]);
		});
		expect(compactedSignals).toHaveLength(0);
		expect(faux.state.callCount).toBe(1);
		expect(storeRecords.some((record) => record.type === "context.compaction")).toBe(false);

		releaseCompaction();
		const reply = await replyPromise;

		expect(reply).toBe("recovered after compact");
		expect(faux.state.callCount).toBe(2);
		expect(compactRequests).toHaveLength(1);
		expect(overflowSignals).toEqual(expect.arrayContaining([expect.objectContaining({ willRetry: true })]));
		expect(compactingSignals).toEqual([{ active: true }, { active: false }]);
		expect(compactedSignals).toHaveLength(1);
		expect(compactedSignals[0]).toEqual(expect.objectContaining({ strategy: "summarize" }));
		expect(Number(compactedSignals[0]?.compactedTurns ?? 0)).toBeGreaterThan(0);
		expect(storeRecords.some((record) => record.type === "context.compaction")).toBe(true);

		const compactedRetryMessages = assembledMessages.find((messages) => {
			return (
				messages.length === 2 &&
				extractTextContent(messages[0]).includes("SUM: compacted context")
			);
		});
		expect(compactedRetryMessages).toBeDefined();
		expect(compactedRetryMessages?.map(extractTextContent)).toEqual(["SUM: compacted context", "trigger overflow"]);
	});
});
