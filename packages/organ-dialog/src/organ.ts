import { randomUUID } from "node:crypto";
import type { MotorEvent, Nerve, Organ, PortDefinition, SensePublishInput } from "@dpopsuev/alef-kernel";
import { extractToolCallId } from "@dpopsuev/alef-kernel";
import { z } from "zod";

const LLM_INPUT = "llm.input" as const;
const LLM_RESPONSE = "llm.response" as const;

export type MessageSink = (text: string, sender: string) => void;

export interface DialogOrganOptions {
	sink?: MessageSink;
}

type PendingRequest = {
	resolve: (text: string) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export class DialogOrgan implements Organ {
	readonly name = "dialog";
	readonly description = "Conversation boundary: routes user messages to organ-llm, delivers replies.";
	readonly labels = ["conversation", "messaging"] as const;
	readonly tools = [] as const;
	readonly publishSchemas = {
		sense: {
			[LLM_INPUT]: z.object({
				text: z.string().min(1),
				sender: z.string().min(1),
			}),
		},
	} as const;
	readonly subscriptions = { motor: [LLM_RESPONSE] as const, sense: [] as const };
	readonly contributions = {
		port: {
			name: "context_observer",
			eventPattern: "sense/dialog.",
			cardinality: "zero-or-one",
		} satisfies PortDefinition,
	};

	private readonly sink: MessageSink;
	private nerve: Nerve | null = null;
	private readonly pending = new Map<string, PendingRequest>();

	constructor(options: DialogOrganOptions = {}) {
		this.sink = options.sink ?? ((text) => process.stdout.write(`agent: ${text}\n`));
	}

	mount(nerve: Nerve): () => void {
		this.nerve = nerve;
		const off = nerve.motor.subscribe(LLM_RESPONSE, (event) => this.handleResponse(event));
		return () => {
			off();
			this.nerve = null;
			this.rejectAllPending(new Error("DialogOrgan: unmounted"));
		};
	}

	receive(text: string, sender = "human", correlationId = randomUUID()): void {
		if (!this.nerve) throw new Error("DialogOrgan: not mounted");
		this.nerve.sense.publish({
			type: LLM_INPUT,
			payload: { text, sender },
			correlationId,
			isError: false,
		});
	}

	send(text: string, sender = "human", timeoutMs = 30_000): Promise<string> {
		if (!this.nerve) return Promise.reject(new Error("DialogOrgan: not mounted"));
		const correlationId = randomUUID();
		return new Promise<string>((resolve, reject) => {
			const timer = this.createTimeout(correlationId, timeoutMs, reject);
			this.pending.set(correlationId, { resolve, reject, timer });
			this.receive(text, sender, correlationId);
		});
	}

	sender(sender = "human"): { send(text: string): string } {
		return {
			send: (text: string) => {
				const correlationId = randomUUID();
				this.receive(text, sender, correlationId);
				return correlationId;
			},
		};
	}

	private handleResponse(event: MotorEvent): void {
		const text = typeof event.payload.text === "string" ? event.payload.text : "";
		const sender = typeof event.payload.sender === "string" ? event.payload.sender : "agent";
		this.sink(text, sender);

		const pending = this.pending.get(event.correlationId);
		if (pending) {
			clearTimeout(pending.timer);
			this.pending.delete(event.correlationId);
			pending.resolve(text);
		}
	}

	private createTimeout(
		correlationId: string,
		timeoutMs: number,
		reject: (e: Error) => void,
	): ReturnType<typeof setTimeout> {
		// lint-ignore: RAWTIMER dialog send deadline — fires once when the agent does not reply within the caller's budget
		return setTimeout(() => {
			this.pending.delete(correlationId);
			reject(new Error(`DialogOrgan.send timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	}

	private rejectAllPending(error: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(error);
		}
		this.pending.clear();
	}
}

export function makeMessageSense(
	motor: MotorEvent,
	payload: Record<string, unknown>,
	isError = false,
	errorMessage?: string,
): SensePublishInput {
	const toolCallId = extractToolCallId(motor.payload);
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		payload: toolCallId ? { ...payload, toolCallId } : payload,
		isError,
		errorMessage,
	};
}
