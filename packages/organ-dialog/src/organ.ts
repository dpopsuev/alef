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
import type { CorpusNerve, CorpusOrgan, MotorEvent, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";

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

export interface DialogOrganOptions {
	/**
	 * Called when the agent publishes Motor/"message".
	 * Defaults to console.log with a simple prefix.
	 */
	sink?: MessageSink;
}

// ---------------------------------------------------------------------------
// DialogOrgan
// ---------------------------------------------------------------------------

export class DialogOrgan implements CorpusOrgan {
	readonly kind = "corpus" as const;
	readonly name = "dialog";
	readonly tools: readonly ToolDefinition[] = [MESSAGE_TOOL];

	private readonly sink: MessageSink;
	private nerve: CorpusNerve | null = null;

	constructor(options: DialogOrganOptions = {}) {
		this.sink = options.sink ?? ((text) => process.stdout.write(`agent: ${text}\n`));
	}

	mount(nerve: CorpusNerve): () => void {
		this.nerve = nerve;

		// Outbound: agent publishes Motor/"dialog.message" → deliver via sink
		const off = nerve.motor.subscribe(DIALOG_MESSAGE, (event) => {
			const text = typeof event.payload.text === "string" ? event.payload.text : "";
			const sender = typeof event.payload.sender === "string" ? event.payload.sender : "agent";
			this.sink(text, sender);
		});

		return () => {
			off();
			this.nerve = null;
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
		this.nerve.sense.publish({
			type: DIALOG_MESSAGE,
			payload: { text, sender },
			correlationId,
			timestamp: Date.now(),
			isError: false,
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
