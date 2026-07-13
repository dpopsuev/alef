/** How many queued messages to inject at a drain point. */
export type QueueMode = "all" | "one-at-a-time";

/** When a mid-turn (or deferred) user message should enter the LLM loop. */
export type DeliveryMode = "steer" | "followUp" | "nextTurn";

/**
 *
 */
export type QueuedInput = {
	payload: Record<string, unknown>;
	correlationId: string;
};

/** Result of attempting to enqueue mid-turn input. */
export type EnqueueResult = { ok: true } | { ok: false; reason: "capacity" };

const DEFAULT_CAPACITY = 32;

/** FIFO queue with live drain mode (pi-aligned). */
export class PendingMessageQueue {
	mode: QueueMode;
	readonly capacity: number;
	private readonly items: QueuedInput[] = [];

	constructor(mode: QueueMode = "one-at-a-time", capacity: number = DEFAULT_CAPACITY) {
		this.mode = mode;
		this.capacity = capacity;
	}

	enqueue(item: QueuedInput, opts?: { force?: boolean }): EnqueueResult {
		if (!opts?.force && this.items.length >= this.capacity) return { ok: false, reason: "capacity" };
		this.items.push(item);
		return { ok: true };
	}

	/** Inspect retained work without removing it. */
	peek(): readonly QueuedInput[] {
		return this.items;
	}

	drain(): QueuedInput[] {
		if (this.items.length === 0) return [];
		if (this.mode === "all") return this.items.splice(0);
		return this.items.splice(0, 1);
	}

	clear(): QueuedInput[] {
		return this.items.splice(0);
	}

	get length(): number {
		return this.items.length;
	}

	hasItems(): boolean {
		return this.items.length > 0;
	}
}

/** Parse delivery from llm.input payload; mid-turn default is steer. */
export function deliveryFromPayload(payload: Record<string, unknown>, midTurn: boolean): DeliveryMode {
	const raw = payload.delivery;
	if (raw === "steer" || raw === "followUp" || raw === "nextTurn") return raw;
	return midTurn ? "steer" : "followUp";
}

/** Total length across steer + follow-up + nextTurn queues (for TUI). */
export function totalQueueLength(...queues: PendingMessageQueue[]): number {
	return queues.reduce((n, q) => n + q.length, 0);
}

/** Compact peek across queues for llm.message-queued payloads. */
export function queueSnapshot(...queues: PendingMessageQueue[]): Array<{
	correlationId: string;
	text?: string;
}> {
	return queues.flatMap((queue) =>
		queue.peek().map((item) => ({
			correlationId: item.correlationId,
			...(typeof item.payload.text === "string" ? { text: item.payload.text } : {}),
		})),
	);
}
