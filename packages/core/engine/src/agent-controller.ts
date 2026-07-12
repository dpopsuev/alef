import { randomUUID } from "node:crypto";
import type { ImageContent, TextContent } from "@dpopsuev/alef-kernel/content";
import type { CommandMessage } from "@dpopsuev/alef-kernel/bus";
import type { Agent } from "./agent.js";

/** Callback invoked when the agent emits a reply event. */
export type ReplySink = (text: string, sender: string) => void;

/** Options for configuring how AgentController routes messages and receives replies. */
export interface AgentControllerOptions {
	onReply?: ReplySink;
	triggerEvent?: string;
	replyEvent?: string;
}

type PendingRequest = {
	resolve: (text: string) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

/** Correlates request/reply pairs over the agent bus with timeout tracking. */
export class AgentController {
	private readonly agent: Agent;
	private readonly triggerEvent: string;
	private readonly onReply: ReplySink;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly unsubscribe: () => void;
	private disposed = false;

	constructor(agent: Agent, opts?: AgentControllerOptions) {
		this.agent = agent;
		this.triggerEvent = opts?.triggerEvent ?? "llm.input";
		this.onReply = opts?.onReply ?? (() => {});
		const replyEvent = opts?.replyEvent ?? "llm.response";
		this.unsubscribe = agent.subscribeCommand(replyEvent, (event) => this.handleReply(event));
		agent.signal.addEventListener("abort", () => this.dispose(), { once: true });
	}

	send(content: string | (TextContent | ImageContent)[], sender = "human", timeoutMs = 30_000): Promise<string> {
		if (this.disposed) return Promise.reject(new Error("AgentController: disposed"));
		const correlationId = randomUUID();
		return new Promise<string>((resolve, reject) => {
			// lint-ignore: RAWTIMER AgentController send deadline — fires once when the agent does not reply within the caller's budget
			const timer = setTimeout(() => {
				this.pending.delete(correlationId);
				reject(new Error(`AgentController.send timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(correlationId, { resolve, reject, timer });
			this.receive(content, sender, correlationId);
		});
	}

	receive(content: string | (TextContent | ImageContent)[], sender = "human", correlationId = randomUUID()): void {
		if (this.disposed) return;
		// Normalize content to array for internal handling
		const contentArray: (TextContent | ImageContent)[] = typeof content === "string" 
			? [{ type: "text", text: content }] 
			: content;
		
		// For backward compatibility, extract text from first text block
		const text = contentArray.find((c): c is TextContent => c.type === "text")?.text ?? "";
		
		this.agent.publishEvent({
			type: this.triggerEvent,
			payload: { text, sender, content: contentArray },
			correlationId,
			isError: false,
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

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error("AgentController: disposed"));
		}
		this.pending.clear();
	}

	private handleReply(event: CommandMessage): void {
		const text = typeof event.payload.text === "string" ? event.payload.text : "";
		const sender = typeof event.payload.sender === "string" ? event.payload.sender : "agent";
		this.onReply(text, sender);

		const pending = this.pending.get(event.correlationId);
		if (pending) {
			clearTimeout(pending.timer);
			this.pending.delete(event.correlationId);
			pending.resolve(text);
		}
	}
}
