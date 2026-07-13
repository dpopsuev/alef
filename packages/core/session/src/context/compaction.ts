import type { ContextAssemblyHandler, ContextAssemblyOutput } from "@dpopsuev/alef-kernel/context-assembly";
import type { SessionStore, StorageRecord } from "../contracts/storage.js";
import { hashRecord } from "../contracts/storage.js";
import {
	applySessionMetadataRefresh,
	parseMetadataFromSummary,
	provisionalTitleFromMessages,
} from "./metadata.js";

/**
 *
 */
export type SummarizeFn = (
	messages: readonly unknown[],
	opts?: { instructions?: string; priorSummary?: string },
) => Promise<string> | string;

/** Auto-compaction strategy: LLM/default summary, deterministic shake, or disabled. */
export type CompactionStrategy = "summarize" | "shake" | "off";

/**
 *
 */
export interface CompactionResult {
	compactedTurns: number;
	preservedTurns: number;
	estimatedBefore: number;
	estimatedAfter: number;
	summary: string;
	firstKeptEventId?: string;
	splitTurn?: boolean;
}

/**
 *
 */
export interface CompactionStageOptions {
	contextWindow?: number;
	/** Tokens reserved below the window before compaction triggers. Default 16384. */
	reserveTokens?: number;
	/** Approx token budget for kept recent tail. Default 20000. */
	keepRecentTokens?: number;
	/** @deprecated Prefer reserveTokens. Kept as fallback: trigger at threshold * window. */
	threshold?: number;
	/** @deprecated Prefer keepRecentTokens. Kept as fallback turn-count cut. */
	preserveRecentTurns?: number;
	/** Auto-compact strategy. Default summarize. Manual :compact still forces summarize unless --strategy=shake. */
	strategy?: CompactionStrategy;
	summarize?: SummarizeFn;
	onCompact?: (result: CompactionResult) => void;
	publishSignal?: (type: string, payload: Record<string, unknown>) => void;
	getLastTokenCount?: () => number;
	sessionStore?: () => SessionStore | undefined;
	/** When set, next assemble forces compaction even below threshold. Cleared after read. */
	pullForceCompact?: () => { instructions?: string; strategy?: CompactionStrategy } | undefined;
}

const CHARS_PER_TOKEN = 4;
const SUMMARY_LINE_MAX_LENGTH = 120;
const SHAKE_TOOL_RESULT_MAX = 400;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_COMPACTION_THRESHOLD = 0.9;
const DEFAULT_PRESERVE_RECENT = 4;
const SCRATCHPAD_PREFIX = "[Scratchpad";
const COMPACTION_TYPE = "context.compaction";
const SEARCH_RECENT_MESSAGE_COUNT = 6;
const SEARCH_RECENT_CHARS = 200;

type RawMessage = {
	role?: string;
	content?: string | Array<{ type?: string; text?: string; id?: string; tool_use_id?: string; name?: string }>;
};

/**
 *
 */
export function estimateTokens(messages: readonly unknown[]): number {
	let chars = 0;
	for (const msg of messages) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message
		const m = msg as RawMessage;
		if (typeof m.content === "string") {
			chars += m.content.length;
		} else if (Array.isArray(m.content)) {
			for (const block of m.content) {
				if (typeof block.text === "string") chars += block.text.length;
				else chars += JSON.stringify(block).length;
			}
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 *
 */
function messageTokens(message: unknown): number {
	return estimateTokens([message]);
}

/**
 *
 */
function isScratchpad(message: unknown): boolean {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message
	const content = (message as RawMessage).content;
	return typeof content === "string" && content.startsWith(SCRATCHPAD_PREFIX);
}

/**
 *
 */
function isToolResultMessage(message: unknown): boolean {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message
	const m = message as RawMessage;
	if (m.role === "tool") return true;
	if (!Array.isArray(m.content)) return false;
	return m.content.some((b) => b.type === "tool_result" || b.type === "tool-result");
}

/**
 *
 */
function hasToolCalls(message: unknown): boolean {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message
	const m = message as RawMessage;
	if (!Array.isArray(m.content)) return false;
	return m.content.some((b) => b.type === "tool_use" || b.type === "tool-call" || b.type === "toolCall");
}

/** Expand cut index left so we never land between tool_use and its tool_result. */
export function alignCutIndex(messages: readonly unknown[], cutIndex: number): number {
	let index = Math.max(0, Math.min(cutIndex, messages.length));
	while (index < messages.length && isToolResultMessage(messages[index])) {
		index--;
		if (index < 0) return 0;
	}
	while (index > 0 && hasToolCalls(messages[index - 1])) {
		let end = index;
		while (end < messages.length && isToolResultMessage(messages[end])) end++;
		if (end > index) {
			index = end;
			break;
		}
		index--;
	}
	return index;
}

/**
 * Find the start index of the kept recent tail by walking back until keepRecentTokens.
 * Returns the first index to keep (aligned to tool boundaries).
 */
export function findKeepStartIndex(
	messages: readonly unknown[],
	keepRecentTokens: number,
): { keepStart: number; splitTurn: boolean } {
	if (messages.length === 0) return { keepStart: 0, splitTurn: false };

	let tokens = 0;
	let keepStart = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		const cost = messageTokens(messages[i]);
		if (tokens > 0 && tokens + cost > keepRecentTokens) {
			break;
		}
		tokens += cost;
		keepStart = i;
	}

	const aligned = alignCutIndex(messages, keepStart);
	const headCost = messageTokens(messages[messages.length - 1]);
	const splitTurn = aligned === messages.length - 1 && headCost > keepRecentTokens && messages.length > 1;
	return { keepStart: aligned, splitTurn };
}

/**
 *
 */
function defaultSummarize(
	messages: readonly unknown[],
	opts?: { instructions?: string; priorSummary?: string },
): string {
	const lines: string[] = ["[Context compacted — earlier turns summarized]", ""];
	if (opts?.priorSummary) {
		lines.push("## Prior summary", opts.priorSummary, "");
	}
	if (opts?.instructions) {
		lines.push(`## Focus: ${opts.instructions}`, "");
	}
	for (const msg of messages) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message
		const m = msg as RawMessage;
		const role = m.role ?? "unknown";
		let text = "";
		if (typeof m.content === "string") {
			text = m.content;
		} else if (Array.isArray(m.content)) {
			text = m.content
				.filter((b): b is { text: string } => typeof b.text === "string")
				.map((b) => b.text)
				.join(" ");
		}
		if (!text) continue;
		const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
		lines.push(`- ${role}: ${firstLine.slice(0, SUMMARY_LINE_MAX_LENGTH)}`);
	}
	return lines.join("\n");
}

/** Truncate large tool_result / string payloads for shake compaction. */
function elideLargePayloads(messages: readonly unknown[]): unknown[] {
	return messages.map((msg) => {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message
		const m = msg as RawMessage;
		if (typeof m.content === "string") {
			if (m.content.length <= SHAKE_TOOL_RESULT_MAX) return msg;
			return {
				...m,
				content: `${m.content.slice(0, SHAKE_TOOL_RESULT_MAX)}…[elided ${m.content.length - SHAKE_TOOL_RESULT_MAX} chars]`,
			};
		}
		if (!Array.isArray(m.content)) return msg;
		const content = m.content.map((block) => {
			if (typeof block.text !== "string" || block.text.length <= SHAKE_TOOL_RESULT_MAX) return block;
			const isTool =
				block.type === "tool_result" || block.type === "tool-result" || block.type === "text";
			if (!isTool && block.type !== undefined) return block;
			return {
				...block,
				text: `${block.text.slice(0, SHAKE_TOOL_RESULT_MAX)}…[elided ${block.text.length - SHAKE_TOOL_RESULT_MAX} chars]`,
			};
		});
		return { ...m, content };
	});
}

/**
 * Deterministic shake lead-in: no summarizer call; tool payloads already elided.
 */
export function shakeSummarize(
	messages: readonly unknown[],
	opts?: { instructions?: string; priorSummary?: string },
): string {
	const elided = elideLargePayloads(messages);
	const lines: string[] = ["[Context shaken — older turns dropped; tool payloads truncated]", ""];
	if (opts?.priorSummary) {
		lines.push("## Prior summary", opts.priorSummary.slice(0, SUMMARY_LINE_MAX_LENGTH * 2), "");
	}
	if (opts?.instructions) {
		lines.push(`## Focus: ${opts.instructions}`, "");
	}
	for (const msg of elided) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message
		const m = msg as RawMessage;
		const role = m.role ?? "unknown";
		let text = "";
		if (typeof m.content === "string") {
			text = m.content;
		} else if (Array.isArray(m.content)) {
			text = m.content
				.filter((b): b is { text: string } => typeof b.text === "string")
				.map((b) => b.text)
				.join(" ");
		}
		if (!text) continue;
		const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
		lines.push(`- ${role}: ${firstLine.slice(0, SUMMARY_LINE_MAX_LENGTH)}`);
	}
	return lines.join("\n");
}

/**
 *
 */
export function latestCompaction(events: readonly StorageRecord[]): StorageRecord | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event?.bus === "internal" && event.type === COMPACTION_TYPE) return event;
	}
	return undefined;
}

/** Events at/after firstKeptEventId (by hash match); if missing, events after the compaction record. */
export function eventsAfterCompaction(
	events: readonly StorageRecord[],
	compaction: StorageRecord,
): StorageRecord[] {
	const firstKept =
		typeof compaction.payload.firstKeptEventId === "string" ? compaction.payload.firstKeptEventId : undefined;
	if (firstKept) {
		const index = events.findIndex((e) => (e.hash ?? hashRecord(e)) === firstKept);
		if (index >= 0) return events.slice(index);
	}
	const compactIndex = events.indexOf(compaction);
	if (compactIndex >= 0) return events.slice(compactIndex + 1);
	return [...events];
}

/**
 *
 */
function injectPriorSummary(messages: readonly unknown[], summary: string): ContextAssemblyOutput {
	const result = [...messages];
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message
	const systemIdx = result.findIndex((m) => (m as RawMessage).role === "system");
	const insertAt = systemIdx >= 0 ? systemIdx + 1 : 0;
	result.splice(insertAt, 0, { role: "user", content: summary });
	return { messages: result };
}

/**
 *
 */
async function resolveFirstKeptEventId(
	store: SessionStore | undefined,
	keptMessages: readonly unknown[],
): Promise<string | undefined> {
	if (!store || keptMessages.length === 0) return undefined;
	const events = await store.events();
	// Prefer the most recent llm.response / llm.input before now as an anchor when
	// we cannot map message objects to event hashes — use last event as watermark
	// and rely on eventsAfterCompaction fallback (slice after compaction record).
	const last = events.at(-1);
	return last ? (last.hash ?? hashRecord(last)) : undefined;
}

/**
 *
 */
export async function compactMessages(
	inputMessages: readonly unknown[],
	opts: {
		keepRecentTokens: number;
		summarize: SummarizeFn;
		priorSummary?: string;
		instructions?: string;
		sessionStore?: SessionStore;
		estimatedBefore: number;
		/** Manual / forced compact: summarize even when history fits keepRecentTokens. */
		force?: boolean;
		/** summarize (default) or shake — never off here (caller skips). */
		strategy?: Exclude<CompactionStrategy, "off">;
	},
): Promise<{ messages: unknown[]; result: CompactionResult }> {
	const messages = [...inputMessages];
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing
	const systemMsg = messages.find((m) => (m as RawMessage).role === "system");
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing
	const nonSystem = messages.filter((m) => (m as RawMessage).role !== "system");
	const strategy = opts.strategy ?? "summarize";
	const summarizeFn: SummarizeFn = strategy === "shake" ? shakeSummarize : opts.summarize;

	const cut = findKeepStartIndex(nonSystem, opts.keepRecentTokens);
	const splitTurn = cut.splitTurn;
	let keepStart = cut.keepStart;
	if (keepStart <= 0 && !splitTurn && nonSystem.length > 0) {
		if (!opts.force || nonSystem.length < 2) {
			return {
				messages,
				result: {
					compactedTurns: 0,
					preservedTurns: nonSystem.length,
					estimatedBefore: opts.estimatedBefore,
					estimatedAfter: opts.estimatedBefore,
					summary: opts.priorSummary ?? "",
				},
			};
		}
		// Force: keep only the last message; summarize everything before it.
		keepStart = nonSystem.length - 1;
	}

	const oldMessages = nonSystem.slice(0, keepStart);
	const toKeep = nonSystem.slice(keepStart);
	const preserved = oldMessages.filter(isScratchpad);
	let toCompact = oldMessages.filter((m) => !isScratchpad(m));
	if (strategy === "shake") {
		toCompact = elideLargePayloads(toCompact);
	}

	let summary: string;
	if (splitTurn && toKeep.length > 0) {
		const oversized = toKeep[0];
		const turnPrefix = oversized ? [oversized] : [];
		const historySummary = await summarizeFn(toCompact, {
			priorSummary: opts.priorSummary,
			instructions: opts.instructions,
		});
		const turnSummary = await summarizeFn(turnPrefix, {
			instructions: opts.instructions ?? "Summarize the start of this oversized turn; keep tool outcomes.",
		});
		summary = `${historySummary}\n\n## Split turn\n${turnSummary}`;
		toCompact = [...toCompact, ...turnPrefix];
		toKeep.shift();
	} else {
		summary = await summarizeFn(toCompact, {
			priorSummary: opts.priorSummary,
			instructions: opts.instructions,
		});
	}

	const compactedMessages: unknown[] = [];
	if (systemMsg) compactedMessages.push(systemMsg);
	compactedMessages.push(...preserved);
	compactedMessages.push({ role: "user", content: summary });
	compactedMessages.push(...toKeep);

	const firstKeptEventId = await resolveFirstKeptEventId(opts.sessionStore, toKeep);
	const result: CompactionResult = {
		compactedTurns: toCompact.length,
		preservedTurns: toKeep.length,
		estimatedBefore: opts.estimatedBefore,
		estimatedAfter: estimateTokens(compactedMessages),
		summary,
		firstKeptEventId,
		splitTurn: splitTurn || undefined,
	};

	if (opts.sessionStore && result.compactedTurns > 0) {
		await opts.sessionStore.append({
			bus: "internal",
			type: COMPACTION_TYPE,
			correlationId: `compact-${Date.now()}`,
			payload: {
				summary,
				firstKeptEventId: firstKeptEventId ?? "",
				tokensBefore: result.estimatedBefore,
				tokensAfter: result.estimatedAfter,
				details: { splitTurn: Boolean(splitTurn), strategy },
			},
			timestamp: Date.now(),
		});
	}

	return { messages: compactedMessages, result };
}

/**
 *
 */
export function createCompactionStage(opts: CompactionStageOptions = {}): ContextAssemblyHandler {
	const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const reserveTokens = opts.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const keepRecentTokens = opts.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
	const threshold = opts.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
	const preserveRecent = opts.preserveRecentTurns ?? DEFAULT_PRESERVE_RECENT;
	const autoStrategy: CompactionStrategy = opts.strategy ?? "summarize";
	const tokenLimit =
		opts.reserveTokens !== undefined || opts.threshold === undefined
			? Math.max(0, contextWindow - reserveTokens)
			: Math.floor(contextWindow * threshold);
	const summarizeFn: SummarizeFn = opts.summarize ?? defaultSummarize;
	const onCompact = opts.onCompact;
	const publishSignal = opts.publishSignal;
	const getLastTokenCount = opts.getLastTokenCount;
	const pullForceCompact = opts.pullForceCompact;

	let lastSummary = "";

	return async (input) => {
		const store = opts.sessionStore?.();
		if (store) {
			const events = await store.events();
			const prior = latestCompaction(events);
			if (prior && typeof prior.payload.summary === "string") {
				lastSummary = prior.payload.summary;
			}
			if (!store.name()) {
				const title = provisionalTitleFromMessages(input.messages);
				if (title) {
					await applySessionMetadataRefresh(store, { reason: "first_message", title });
					publishSignal?.("session.metadata.refresh", { reason: "first_message", title });
				}
			}
		}

		const force = pullForceCompact?.();
		const apiCount = getLastTokenCount?.() ?? 0;
		const estimated = Math.max(apiCount, estimateTokens(input.messages));

		if (!force && autoStrategy === "off") {
			if (lastSummary) {
				return injectPriorSummary(input.messages, lastSummary);
			}
			return {};
		}

		if (!force && estimated <= tokenLimit) {
			if (lastSummary) {
				return injectPriorSummary(input.messages, lastSummary);
			}
			return {};
		}

		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing
		const nonSystem = input.messages.filter((m) => (m as RawMessage).role !== "system");
		const useTokenCut = opts.keepRecentTokens !== undefined || opts.preserveRecentTurns === undefined;
		if (!force && !useTokenCut && nonSystem.length <= preserveRecent) {
			return {};
		}

		const effectiveKeep = useTokenCut
			? keepRecentTokens
			: Math.max(
					1,
					estimateTokens(nonSystem.slice(-preserveRecent)) || keepRecentTokens,
				);

		// Manual force ignores auto "off" and defaults to summarize unless shake requested.
		const runStrategy: Exclude<CompactionStrategy, "off"> =
			force?.strategy === "shake" || (!force && autoStrategy === "shake") ? "shake" : "summarize";

		const { messages: compactedMessages, result } = await compactMessages(input.messages, {
			keepRecentTokens: effectiveKeep,
			summarize: summarizeFn,
			priorSummary: lastSummary || undefined,
			instructions: force?.instructions,
			sessionStore: store,
			estimatedBefore: estimated,
			force: Boolean(force),
			strategy: runStrategy,
		});

		if (result.compactedTurns === 0 && !force) {
			if (lastSummary) return injectPriorSummary(input.messages, lastSummary);
			return {};
		}

		lastSummary = result.summary || lastSummary;
		if (store && result.summary) {
			const meta = parseMetadataFromSummary(result.summary);
			const recentTexts = nonSystem
				.slice(-SEARCH_RECENT_MESSAGE_COUNT)
				.map((m) => {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing
					const msg = m as RawMessage;
					return typeof msg.content === "string" ? msg.content.slice(0, SEARCH_RECENT_CHARS) : "";
				})
				.filter(Boolean);
			await applySessionMetadataRefresh(store, {
				reason: "compact",
				title: meta.title,
				tags: meta.tags.length > 0 ? meta.tags : undefined,
				summary: result.summary,
				recentTexts,
			});
			publishSignal?.("session.metadata.refresh", {
				reason: "compact",
				title: meta.title,
				tags: meta.tags,
			});
		}
		onCompact?.(result);
		publishSignal?.("context.compacted", {
			compactedTurns: result.compactedTurns,
			preservedTurns: result.preservedTurns,
			estimatedBefore: result.estimatedBefore,
			estimatedAfter: result.estimatedAfter,
			splitTurn: result.splitTurn,
			strategy: runStrategy,
		});

		return { messages: compactedMessages };
	};
}
