import { randomUUID } from "node:crypto";
import type { ZodTypeAny, z } from "zod";

/** Makes loss behavior explicit for each event class. */
export type EventOverflowPolicy = "reject" | "drop" | "coalesce";

/** Pins a fact's identity to its payload schema and overflow policy. */
export interface EventContract<TPayloadSchema extends ZodTypeAny> {
	readonly type: string;
	readonly version: number;
	readonly payload: TPayloadSchema;
	readonly overflow: EventOverflowPolicy;
}

/** Freezes event identity before subscribers bind to it. */
export function defineEvent<TPayloadSchema extends ZodTypeAny>(definition: {
	type: string;
	version: number;
	payload: TPayloadSchema;
	overflow: EventOverflowPolicy;
}): EventContract<TPayloadSchema> {
	if (!definition.type.trim()) throw new Error("event type must not be empty");
	if (!Number.isInteger(definition.version) || definition.version < 1) {
		throw new Error("event version must be a positive integer");
	}
	return Object.freeze({ ...definition });
}

/** Carries lifecycle identity without encoding scope into correlation strings. */
export interface EventScope {
	readonly runId?: string;
	readonly sessionId?: string;
	readonly serviceId?: string;
}

/** Records causal and scoped identity for an already-observed fact. */
export interface EventEnvelope<TPayload = unknown> {
	readonly id: string;
	readonly type: string;
	readonly version: number;
	readonly timestamp: number;
	readonly correlationId?: string;
	readonly causationId?: string;
	readonly scope: EventScope;
	readonly payload: TPayload;
}

/** Connects a fact to its cause and owning lifecycle. */
export interface EventPublishOptions {
	readonly correlationId?: string;
	readonly causationId?: string;
	readonly scope?: EventScope;
}

/** Bounds delivery work and exposes loss or subscriber failure. */
export interface EventHubOptions {
	readonly capacity: number;
	readonly concurrency: number;
	readonly onDrop?: (event: EventEnvelope) => void;
	readonly onHandlerError?: (info: { type: string; version: number; error: unknown }) => void;
}

/** Fails non-droppable facts instead of silently losing them. */
export class EventHubOverflowError extends Error {
	constructor(type: string, capacity: number) {
		super(`event hub capacity ${capacity} exceeded while publishing ${type}`);
		this.name = "EventHubOverflowError";
	}
}

type AnyContract = EventContract<ZodTypeAny>;
type EventHandler = (event: EventEnvelope) => void | Promise<void>;
type PendingEvent = {
	contract: AnyContract;
	envelope: EventEnvelope;
	resolve: (envelope: EventEnvelope) => void;
	reject: (error: unknown) => void;
};

/** Prevents subscribers from consuming incompatible event versions. */
function eventKey(type: string, version: number): string {
	return `${type}@${version}`;
}

/** Coalesces only facts from the same type, version, and lifecycle scope. */
function coalesceKey(event: EventEnvelope): string {
	return JSON.stringify([event.type, event.version, event.scope]);
}

/** Bounds one-to-many fact delivery independently from command execution. */
export class EventHub {
	private readonly handlers = new Map<string, Set<EventHandler>>();
	private readonly queue: PendingEvent[] = [];
	private active = 0;
	private closed = false;

	constructor(private readonly options: EventHubOptions) {
		if (!Number.isInteger(options.capacity) || options.capacity < 1) {
			throw new Error("event hub capacity must be a positive integer");
		}
		if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
			throw new Error("event hub concurrency must be a positive integer");
		}
	}

	subscribe<TPayloadSchema extends ZodTypeAny>(
		contract: EventContract<TPayloadSchema>,
		handler: (event: EventEnvelope<z.output<TPayloadSchema>>) => void | Promise<void>,
	): () => void {
		const key = eventKey(contract.type, contract.version);
		let handlers = this.handlers.get(key);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(key, handlers);
		}
		const storedHandler: EventHandler = (event) =>
			handler({ ...event, payload: contract.payload.parse(event.payload) });
		handlers.add(storedHandler);
		return () => handlers.delete(storedHandler);
	}

	publish<TPayloadSchema extends ZodTypeAny>(
		contract: EventContract<TPayloadSchema>,
		payload: z.input<TPayloadSchema>,
		options: EventPublishOptions = {},
	): Promise<EventEnvelope<z.output<TPayloadSchema>>> {
		if (this.closed) return Promise.reject(new Error("event hub is closed"));
		const parsed = contract.payload.safeParse(payload);
		if (!parsed.success) return Promise.reject(new Error(`${contract.type}@${contract.version} has invalid payload`));
		const envelope: EventEnvelope<z.output<TPayloadSchema>> = {
			id: randomUUID(),
			type: contract.type,
			version: contract.version,
			timestamp: Date.now(),
			correlationId: options.correlationId,
			causationId: options.causationId,
			scope: Object.freeze({ ...(options.scope ?? {}) }),
			payload: parsed.data,
		};

		if (this.active + this.queue.length >= this.options.capacity) {
			if (contract.overflow === "drop") {
				this.options.onDrop?.(envelope);
				return Promise.resolve(envelope);
			}
			if (contract.overflow === "coalesce") {
				const pending = this.queue.find((entry) => coalesceKey(entry.envelope) === coalesceKey(envelope));
				if (pending) {
					this.options.onDrop?.(pending.envelope);
					pending.resolve(pending.envelope);
					return new Promise<EventEnvelope<z.output<TPayloadSchema>>>((resolve, reject) => {
						pending.contract = contract;
						pending.envelope = envelope;
						pending.resolve = (delivered) => {
							// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Coalescing keeps the replacement contract and envelope together.
							resolve(delivered as EventEnvelope<z.output<TPayloadSchema>>);
						};
						pending.reject = reject;
					});
				}
			}
			return Promise.reject(new EventHubOverflowError(contract.type, this.options.capacity));
		}

		return new Promise<EventEnvelope<z.output<TPayloadSchema>>>((resolve, reject) => {
			this.queue.push({
				contract,
				envelope,
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Pending delivery preserves this envelope's validated payload type.
				resolve: resolve as (event: EventEnvelope) => void,
				reject,
			});
			this.drain();
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const error = new Error("event hub is closed");
		for (const pending of this.queue.splice(0)) pending.reject(error);
		this.handlers.clear();
	}

	private drain(): void {
		while (!this.closed && this.active < this.options.concurrency && this.queue.length > 0) {
			const pending = this.queue.shift();
			if (!pending) return;
			this.active++;
			void this.deliver(pending).finally(() => {
				this.active--;
				this.drain();
			});
		}
	}

	private async deliver(pending: PendingEvent): Promise<void> {
		const handlers = [...(this.handlers.get(eventKey(pending.contract.type, pending.contract.version)) ?? [])];
		await Promise.all(
			handlers.map(async (handler) => {
				try {
					await handler(pending.envelope);
				} catch (error) {
					this.options.onHandlerError?.({
						type: pending.envelope.type,
						version: pending.envelope.version,
						error,
					});
				}
			}),
		);
		pending.resolve(pending.envelope);
	}
}
