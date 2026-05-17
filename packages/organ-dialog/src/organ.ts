/**
 * DialogOrgan — message boundary CorpusOrgan.
 *
 * Owns the seam between the external world and the agent's reasoning bus.
 * Sender identity (human, agent, system) is metadata — not part of the
 * event type. Human-to-agent and agent-to-agent messages are the same event.
 *
 * Inbound:  organ.receive(text, sender?) → Sense/"message"
 * Outbound: Motor/"message"             → configurable sink (stdout by default)
 *
 * The LLM uses the "message" tool to send replies. Same event name on
 * both buses — the bus direction (Motor vs Sense) is the only discriminant.
 */

import { randomUUID } from "node:crypto";
import type { MotorEvent, Nerve, Organ, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";

// ---------------------------------------------------------------------------
// Event name — one name, two buses
// ---------------------------------------------------------------------------

export const DIALOG_MESSAGE = "dialog.message";

// ---------------------------------------------------------------------------
// Tool definition — LLM sends a message via this tool
// ---------------------------------------------------------------------------

const MESSAGE_TOOL: ToolDefinition = {
	name: DIALOG_MESSAGE,
	description: "Send a message. Use this to reply to the user or to another agent.",
	inputSchema: {
		type: "object",
		properties: {
			text: { type: "string", description: "The message text." },
		},
		required: ["text"],
		additionalProperties: false,
	},
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Sink for outbound Motor/"message" events. */
export type MessageSink = (text: string, sender: string) => void;

/** Minimal conversation turn — role + text content. Compatible with alef-ai Message. */
export interface ConversationMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

export interface DialogOrganOptions {
	/**
	 * Called when the agent publishes Motor/"dialog.message".
	 * Defaults to writing to stdout with a simple prefix.
	 */
	sink?: MessageSink;
	/**
	 * Returns the current tool definitions available to the LLM.
	 * Pass () => corpus.tools so DialogOrgan includes the tool list
	 * in each Sense/"dialog.message" payload.
	 */
	getTools?: () => readonly ToolDefinition[];
	/**
	 * Optional system prompt prepended to every conversation.
	 * Injected as a system message at position 0 of each payload.messages.
	 */
	systemPrompt?: string;
	/**
	 * Maximum number of send() calls (user turns) per session.
	 * 0 = unlimited. Default: 0.
	 * When exceeded, send() rejects with a clear error message.
	 */
	maxTurns?: number;
}

// ---------------------------------------------------------------------------
// DialogOrgan
// ---------------------------------------------------------------------------

export class DialogOrgan implements Organ {
	readonly name = "dialog";
	readonly tools: readonly ToolDefinition[] = [MESSAGE_TOOL];
	/**
	 * Declare subscriptions so Agent.validate() never probes via a second mount().
	 * DialogOrgan subscribes Motor/dialog.message (receives agent replies).
	 * It does not subscribe Sense — it publishes Sense via receive().
	 */
	readonly subscriptions = { motor: ["dialog.message"] as const, sense: [] as const };

	private readonly sink: MessageSink;
	private readonly getTools: () => readonly ToolDefinition[];
	private readonly systemPrompt: string | undefined;
	private readonly maxTurns: number;
	private turnCount = 0;
	/** Conversation history — accumulates across turns. */
	private readonly history: ConversationMessage[] = [];
	private nerve: Nerve | null = null;
	private readonly pending = new Map<
		string,
		{ resolve: (text: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();

	constructor(options: DialogOrganOptions = {}) {
		this.sink = options.sink ?? ((text) => process.stdout.write(`agent: ${text}\n`));
		this.getTools = options.getTools ?? (() => []);
		this.systemPrompt = options.systemPrompt;
		this.maxTurns = options.maxTurns ?? 0;
	}

	/** Reset conversation history. Useful between independent sessions. */
	clearHistory(): void {
		this.history.length = 0;
	}

	/** Read-only snapshot of current history. */
	get messages(): readonly ConversationMessage[] {
		return this.history;
	}

	private buildPayload(text: string, sender: string): Record<string, unknown> {
		const userMsg: ConversationMessage = { role: "user", content: text };
		const messages: ConversationMessage[] = this.systemPrompt
			? [{ role: "system", content: this.systemPrompt }, ...this.history, userMsg]
			: [...this.history, userMsg];
		return { text, sender, messages, tools: this.getTools() };
	}

	mount(nerve: Nerve): () => void {
		this.nerve = nerve;

		// Outbound: agent publishes Motor/"dialog.message" → deliver via sink + resolve pending send()
		const off = nerve.motor.subscribe(DIALOG_MESSAGE, (event) => {
			const text = typeof event.payload.text === "string" ? event.payload.text : "";
			const sender = typeof event.payload.sender === "string" ? event.payload.sender : "agent";

			// Append assistant reply to history before resolving.
			this.history.push({ role: "assistant", content: text });
			this.sink(text, sender);

			// Resolve any awaiting send() with matching correlationId.
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
			// Reject any pending sends — organ was unmounted
			for (const [, p] of this.pending) {
				clearTimeout(p.timer);
				p.reject(new Error("DialogOrgan: unmounted"));
			}
			this.pending.clear();
		};
	}

	/**
	 * Receive a message from the external world.
	 *
	 * Call this from the CLI (stdin), an HTTP handler, an MCP server,
	 * or an upstream agent — the event type is the same regardless of source.
	 *
	 * @param text     Message content.
	 * @param sender   Who sent it — "human", "agent:planner", "system", etc.
	 *                 Metadata only; does not affect routing.
	 * @param correlationId  Optional — generated if omitted.
	 */
	receive(text: string, sender = "human", correlationId = randomUUID()): void {
		if (!this.nerve) throw new Error("DialogOrgan: not mounted");
		// Build payload from history BEFORE appending — payload includes userMsg explicitly.
		const payload = this.buildPayload(text, sender);
		// Append user message to history after building payload.
		this.history.push({ role: "user", content: text });
		this.nerve.sense.publish({
			type: DIALOG_MESSAGE,
			payload,
			correlationId,
			timestamp: Date.now(),
			isError: false,
		});
	}

	/**
	 * Send a message and await the agent's reply.
	 * Replaces corpus.prompt() — the dialog organ owns request-reply tracking.
	 */
	send(text: string, sender = "human", timeoutMs = 30_000): Promise<string> {
		if (!this.nerve) return Promise.reject(new Error("DialogOrgan: not mounted"));
		if (this.maxTurns > 0 && this.turnCount >= this.maxTurns) {
			return Promise.reject(new Error(`Max turns reached (${this.maxTurns}). Start a new session to continue.`));
		}
		this.turnCount++;
		const correlationId = randomUUID();
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(correlationId);
				reject(new Error(`DialogOrgan.send timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(correlationId, { resolve, reject, timer });
			this.receive(text, sender, correlationId);
		});
	}

	/**
	 * Returns a typed sender handle — useful when you want to capture the
	 * correlationId for awaiting a reply.
	 */
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

// ---------------------------------------------------------------------------
// Helpers for organs that publish Sense/"message" results
// ---------------------------------------------------------------------------

export function makeMessageSense(
	motor: MotorEvent,
	payload: Record<string, unknown>,
	isError = false,
	errorMessage?: string,
): SenseEvent {
	const toolCallId = typeof motor.payload.toolCallId === "string" ? motor.payload.toolCallId : undefined;
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		timestamp: Date.now(),
		payload: toolCallId ? { ...payload, toolCallId } : payload,
		isError,
		errorMessage,
	};
}
