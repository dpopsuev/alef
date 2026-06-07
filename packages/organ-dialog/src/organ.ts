/**
 * DialogOrgan — message boundary CorpusOrgan.
 *
 * Owns the seam between the external world and the agent's reasoning bus.
 *
 * Inbound:  organ.receive(text, sender?) → Sense/"dialog.message" { text, sender }
 * Outbound: Motor/"dialog.message"       → configurable sink (stdout by default)
 *
 * Context assembly (messages, tools, system prompt) is the responsibility of
 * prepareStep (production) or AgentLoopOptions.getTools/systemPrompt (subagents).
 */

import { randomUUID } from "node:crypto";
import type { MotorEvent, Nerve, Organ, SensePublishInput, ToolDefinition } from "@dpopsuev/alef-kernel";
import { extractToolCallId } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export const DIALOG_MESSAGE = "dialog.message" as const;

const MESSAGE_TOOL: ToolDefinition = {
	name: DIALOG_MESSAGE,
	description: "Send a message. Use this to reply to the user or to another agent.",
	inputSchema: z.object({
		text: z.string().min(1).describe("The message text."),
	}),
};

export type MessageSink = (text: string, sender: string) => void;

export interface DialogOrganOptions {
	sink?: MessageSink;
}

export class DialogOrgan implements Organ {
	readonly name = "dialog";
	readonly description = "Conversation boundary: routes user messages to the LLM, delivers replies.";
	readonly labels = ["conversation", "messaging"] as const;
	readonly tools: readonly ToolDefinition[] = [MESSAGE_TOOL];
	readonly publishSchemas = {
		sense: {
			"dialog.message": z.object({
				text: z.string().min(1),
				sender: z.string().min(1),
			}),
		},
	} as const;
	readonly subscriptions = { motor: ["dialog.message"] as const, sense: [] as const };

	private readonly sink: MessageSink;
	private nerve: Nerve | null = null;
	private readonly pending = new Map<
		string,
		{ resolve: (text: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();

	constructor(options: DialogOrganOptions = {}) {
		this.sink = options.sink ?? ((text) => process.stdout.write(`agent: ${text}\n`));
	}

	mount(nerve: Nerve): () => void {
		this.nerve = nerve;

		const off = nerve.motor.subscribe(DIALOG_MESSAGE, (event) => {
			const text = typeof event.payload.text === "string" ? event.payload.text : "";
			const sender = typeof event.payload.sender === "string" ? event.payload.sender : "agent";
			this.sink(text, sender);

			const pending = this.pending.get(event.correlationId);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(event.correlationId);
				pending.resolve(text);
			}
		});

		return () => {
			off();
			this.nerve = null;
			for (const [, p] of this.pending) {
				clearTimeout(p.timer);
				p.reject(new Error("DialogOrgan: unmounted"));
			}
			this.pending.clear();
		};
	}

	receive(text: string, sender = "human", correlationId = randomUUID()): void {
		if (!this.nerve) throw new Error("DialogOrgan: not mounted");
		this.nerve.sense.publish({
			type: DIALOG_MESSAGE,
			payload: { text, sender },
			correlationId,
			isError: false,
		});
	}

	send(text: string, sender = "human", timeoutMs = 30_000): Promise<string> {
		if (!this.nerve) return Promise.reject(new Error("DialogOrgan: not mounted"));
		const correlationId = randomUUID();
		return new Promise<string>((resolve, reject) => {
			// lint-ignore: RAWTIMER conversation wall-clock deadline, not a stall detector
			const timer = setTimeout(() => {
				this.pending.delete(correlationId);
				reject(new Error(`DialogOrgan.send timed out after ${timeoutMs}ms`));
			}, timeoutMs);
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
