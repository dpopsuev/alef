const DEFAULT_PIN_RECENT_TURNS = 3;
const DEFAULT_SIMILARITY_WEIGHT = 0.85;
const CHARS_PER_TOKEN = 4;
const TOP_SCORES_LIMIT = 10;

type RawMessage = {
	role?: string;
	content?: string | Array<{ type?: string; text?: string }>;
};

/** One turn subgraph projected as a contiguous message slice. */
export interface AttentionTurn {
	id: string;
	index: number;
	messages: unknown[];
	tokenCost: number;
	text: string;
}

/** Options for heap selection under a token budget. */
export interface AttentionSelectOptions {
	/** Max tokens for the assembled window (system + selected turns). */
	tokenLimit: number;
	/** Always keep the last N turns. Default 3. */
	pinRecentTurns?: number;
	/** Weight on similarity vs ordinal recency. Default 0.85. */
	similarityWeight?: number;
	/** Per-turn similarity in [0, 1]. Missing → 0 (recency still applies). */
	similarityByTurnId?: ReadonlyMap<string, number>;
}

/** Outcome of an Attention assemble (window only; store unchanged). */
export interface AttentionResult {
	keptTurnIds: string[];
	droppedTurnIds: string[];
	estimatedBefore: number;
	estimatedAfter: number;
	queryRoles: string[];
	topScores: Array<{ turnId: string; score: number }>;
}

/** Narrow unknown tool payload fragments to plain records. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Read role from an untyped message object. */
function messageRole(message: unknown): string {
	if (!isRecord(message)) return "unknown";
	return typeof message.role === "string" ? message.role : "unknown";
}

/** True when message content is a scratchpad prefix. */
function isScratchpad(message: unknown): boolean {
	if (!isRecord(message)) return false;
	const content = message.content;
	return typeof content === "string" && content.startsWith("[Scratchpad");
}

/** True for tool / toolResult roles or tool_result content blocks. */
function isToolResultMessage(message: unknown): boolean {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message
	const m = message as RawMessage;
	if (m.role === "tool" || m.role === "toolResult") return true;
	if (!Array.isArray(m.content)) return false;
	return m.content.some((block) => block.type === "tool_result" || block.type === "tool-result");
}

/** Flatten message content to plain text for scoring. */
function messageText(message: unknown): string {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message
	const m = message as RawMessage;
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return m.content
		.filter((block): block is { text: string } => typeof block.text === "string")
		.map((block) => block.text)
		.join(" ");
}

/** Approximate token count from message character length. */
function estimateTokens(messages: readonly unknown[]): number {
	let chars = 0;
	for (const message of messages) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped message
		const m = message as RawMessage;
		if (typeof m.content === "string") {
			chars += m.content.length;
		} else if (Array.isArray(m.content)) {
			for (const block of m.content) {
				if (typeof block.text === "string") chars += block.text.length;
				else chars += JSON.stringify(block).length;
			}
		} else if (isRecord(message)) {
			chars += JSON.stringify(message).length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Cosine similarity; empty or mismatched vectors → 0. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Merge bidirectional turn scores with max. */
export function mergeBidirectionalScores(
	scoresIn: ReadonlyMap<string, number>,
	scoresOut?: ReadonlyMap<string, number>,
): Map<string, number> {
	const merged = new Map(scoresIn);
	if (!scoresOut) return merged;
	for (const [id, score] of scoresOut) {
		const current = merged.get(id) ?? 0;
		if (score > current) merged.set(id, score);
	}
	return merged;
}

/**
 * Partition messages into system prefix + turn slices.
 * A turn starts at a user message (or first non-system); tool results stay with prior turn.
 */
export function partitionAttentionTurns(messages: readonly unknown[]): {
	system: unknown[];
	turns: AttentionTurn[];
} {
	const system: unknown[] = [];
	const turns: AttentionTurn[] = [];
	let current: unknown[] = [];
	let turnIndex = 0;

	const flush = (): void => {
		if (current.length === 0) return;
		const id = `turn-${turnIndex}`;
		const text = current.map(messageText).join("\n");
		turns.push({
			id,
			index: turnIndex,
			messages: current,
			tokenCost: Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN)),
			text,
		});
		turnIndex++;
		current = [];
	};

	for (const message of messages) {
		const role = messageRole(message);
		if (role === "system") {
			flush();
			system.push(message);
			continue;
		}
		const startsTurn =
			current.length === 0 ||
			(role === "user" && !isToolResultMessage(message) && !isScratchpad(message));
		if (startsTurn && current.length > 0) flush();
		current.push(message);
	}
	flush();
	return { system, turns };
}

/** Extract query texts for bidirectional scoring from the message list. */
export function extractAttentionQueries(messages: readonly unknown[]): {
	queryIn: string;
	queryOut: string | undefined;
	queryRoles: string[];
} {
	const { turns } = partitionAttentionTurns(messages);
	const queryRoles: string[] = [];
	let queryIn = "";
	let queryOut: string | undefined;

	for (let i = turns.length - 1; i >= 0; i--) {
		const turn = turns[i]!;
		for (let j = turn.messages.length - 1; j >= 0; j--) {
			const message = turn.messages[j]!;
			const role = messageRole(message);
			const text = messageText(message).trim();
			if (!text) continue;
			if (!queryIn && role === "user") {
				queryIn = text;
				queryRoles.push("user");
			} else if (!queryOut && (role === "assistant" || role === "model")) {
				queryOut = text;
				queryRoles.push("assistant");
			}
			if (queryIn && queryOut) {
				return { queryIn, queryOut, queryRoles };
			}
		}
	}
	return { queryIn, queryOut, queryRoles };
}

/**
 * Heap selection: pin system + last N + scratchpad turns; fill remaining budget by score.
 * Selected turns are returned in chronological order. Store is untouched.
 */
export function selectAttentionTurns(
	turns: readonly AttentionTurn[],
	opts: AttentionSelectOptions,
): { selected: AttentionTurn[]; result: Omit<AttentionResult, "estimatedBefore" | "estimatedAfter" | "queryRoles"> } {
	const pinRecent = opts.pinRecentTurns ?? DEFAULT_PIN_RECENT_TURNS;
	const alpha = opts.similarityWeight ?? DEFAULT_SIMILARITY_WEIGHT;
	const similarities = opts.similarityByTurnId;
	const hasSimilarity = Boolean(similarities && similarities.size > 0);
	const maxIndex = Math.max(1, turns.length - 1);

	const pinnedIds = new Set<string>();
	for (const turn of turns.slice(-pinRecent)) pinnedIds.add(turn.id);
	for (const turn of turns) {
		if (turn.messages.some(isScratchpad)) pinnedIds.add(turn.id);
	}

	const scored = turns.map((turn) => {
		const recency = turn.index / maxIndex;
		const sim = similarities?.get(turn.id) ?? 0;
		const score = hasSimilarity ? alpha * sim + (1 - alpha) * recency : recency;
		return { turn, score };
	});

	const pinned = scored.filter((entry) => pinnedIds.has(entry.turn.id));
	const candidates = scored
		.filter((entry) => !pinnedIds.has(entry.turn.id))
		.sort((a, b) => b.score - a.score || b.turn.index - a.turn.index);

	let used = pinned.reduce((sum, entry) => sum + entry.turn.tokenCost, 0);
	const kept = new Map<string, AttentionTurn>();
	for (const entry of pinned) kept.set(entry.turn.id, entry.turn);

	for (const entry of candidates) {
		if (used + entry.turn.tokenCost > opts.tokenLimit) continue;
		kept.set(entry.turn.id, entry.turn);
		used += entry.turn.tokenCost;
	}

	const selected = [...kept.values()].sort((a, b) => a.index - b.index);
	const keptTurnIds = selected.map((turn) => turn.id);
	const keptSet = new Set(keptTurnIds);
	const droppedTurnIds = turns.filter((turn) => !keptSet.has(turn.id)).map((turn) => turn.id);
	const topScores = scored
		.slice()
		.sort((a, b) => b.score - a.score)
		.slice(0, TOP_SCORES_LIMIT)
		.map((entry) => ({ turnId: entry.turn.id, score: entry.score }));

	return { selected, result: { keptTurnIds, droppedTurnIds, topScores } };
}

/** attendMessages options including optional async scorer. */
export interface AttendMessagesOptions extends AttentionSelectOptions {
	/** Optional async scorer; overrides similarityByTurnId when provided. */
	scoreTurns?: (turns: readonly AttentionTurn[]) => Promise<ReadonlyMap<string, number>>;
}

/**
 * Drop low-scoring turns from the assembled message window under a token budget.
 * Does not mutate the session store.
 */
export async function attendMessages(
	messages: readonly unknown[],
	opts: AttendMessagesOptions,
): Promise<{ messages: unknown[]; result: AttentionResult }> {
	const estimatedBefore = estimateTokens(messages);
	const { system, turns } = partitionAttentionTurns(messages);
	const systemTokens = estimateTokens(system);
	const turnBudget = Math.max(0, opts.tokenLimit - systemTokens);
	const { queryIn, queryOut, queryRoles } = extractAttentionQueries(messages);

	let similarityByTurnId = opts.similarityByTurnId;
	if (opts.scoreTurns) {
		similarityByTurnId = await opts.scoreTurns(turns);
	}

	const { selected, result } = selectAttentionTurns(turns, {
		tokenLimit: turnBudget,
		pinRecentTurns: opts.pinRecentTurns,
		similarityWeight: opts.similarityWeight,
		similarityByTurnId,
	});

	const assembled = [...system, ...selected.flatMap((turn) => turn.messages)];
	return {
		messages: assembled,
		result: {
			...result,
			estimatedBefore,
			estimatedAfter: estimateTokens(assembled),
			queryRoles: queryRoles.length > 0 ? queryRoles : queryIn ? ["user"] : queryOut ? ["assistant"] : [],
		},
	};
}

/** Build turn similarities from query embedding(s) and per-turn text embeddings. */
export async function scoreTurnsByEmbedding(opts: {
	turns: readonly AttentionTurn[];
	queryIn: string;
	queryOut?: string;
	embed: (text: string) => Promise<number[]>;
}): Promise<Map<string, number>> {
	const embed = opts.embed;
	const qIn = opts.queryIn.trim() ? await embed(opts.queryIn) : undefined;
	const qOut = opts.queryOut?.trim() ? await embed(opts.queryOut) : undefined;
	const scores = new Map<string, number>();
	for (const turn of opts.turns) {
		if (!turn.text.trim()) {
			scores.set(turn.id, 0);
			continue;
		}
		const turnEmbedding = await embed(turn.text);
		let sim = 0;
		if (qIn) sim = Math.max(sim, cosineSimilarity(qIn, turnEmbedding));
		if (qOut) sim = Math.max(sim, cosineSimilarity(qOut, turnEmbedding));
		scores.set(turn.id, sim);
	}
	return scores;
}
