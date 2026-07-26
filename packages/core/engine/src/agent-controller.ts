import { randomUUID } from "node:crypto";
import type { ImageContent, TextContent } from "@dpopsuev/alef-kernel/content";
import type { CommandMessage } from "@dpopsuev/alef-kernel/bus";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { Agent } from "./agent.js";

/** Callback invoked when the agent emits a reply event. */
export type ReplySink = (text: string, sender: string) => void;

/** Persists Run transitions around host request/reply control. */
export interface RunLifecycle {
	start(runId: string): Promise<void>;
	complete(runId: string): Promise<void>;
	fail(runId: string, reason: string): Promise<void>;
	cancel(runId: string): Promise<void>;
}

/** Options for configuring host callbacks and durable Run ownership. */
export interface AgentControllerOptions {
	onReply?: ReplySink;
	triggerEvent?: string;
	replyEvent?: string;
	runLifecycle?: RunLifecycle;
}

type PendingRequest = {
	resolve: (text: string) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

/** Correlates request/reply pairs while committing their Run lifecycle. */
export class AgentController {
	private readonly agent: Agent;
	private readonly triggerEvent: string;
	private readonly onReply: ReplySink;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly runLifecycle: RunLifecycle | undefined;
	private readonly unsubscribe: () => void;
	private disposed = false;

	constructor(agent: Agent, opts?: AgentControllerOptions) {
		this.agent = agent;
		this.triggerEvent = opts?.triggerEvent ?? "llm.input";
		this.onReply = opts?.onReply ?? (() => {});
		this.runLifecycle = opts?.runLifecycle;
		const replyEvent = opts?.replyEvent ?? "llm.response";
		this.unsubscribe = agent.subscribeCommand(replyEvent, (event) => this.handleReply(event));
		agent.signal.addEventListener("abort", () => this.dispose(), { once: true });
	}

	send(content: string | (TextContent | ImageContent)[], sender = "human", timeoutMs = 30_000): Promise<string> {
		if (this.disposed) return Promise.reject(new Error("AgentController: disposed"));
		const correlationId = randomUUID();
		return new Promise<string>((resolve, reject) => {
			// lint-ignore: RAWTIMER AgentController send deadline — fails the host wait but never approves policy.
			const timer = setTimeout(() => {
				this.pending.delete(correlationId);
				const message = `AgentController.send timed out after ${timeoutMs}ms`;
				void this.runLifecycle?.fail(correlationId, message);
				reject(new Error(message));
			}, timeoutMs);
			this.pending.set(correlationId, { resolve, reject, timer });
			void this.startAndPublish(content, sender, correlationId).catch((error: unknown) => {
				clearTimeout(timer);
				this.pending.delete(correlationId);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	receive(
		content: string | (TextContent | ImageContent)[],
		sender = "human",
		correlationId = randomUUID(),
		delivery?: "steer" | "followUp" | "nextTurn",
	): void {
		if (this.disposed) return;
		void this.startAndPublish(content, sender, correlationId, delivery).catch((error: unknown) => {
			traceEvent("run:start-failed", { correlationId, error: error instanceof Error ? error.message : String(error) });
		});
	}

	sender(sender = "human"): { send(text: string): string } {
		return {
			send: (text: string) => {
				const correlationId = randomUUID();
				void this.receive(text, sender, correlationId);
				return correlationId;
			},
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		for (const [runId, pending] of this.pending) {
			clearTimeout(pending.timer);
			void this.runLifecycle?.cancel(runId);
			pending.reject(new Error("AgentController: disposed"));
		}
		this.pending.clear();
	}

	private async startAndPublish(
		content: string | (TextContent | ImageContent)[],
		sender: string,
		correlationId: string,
		delivery?: "steer" | "followUp" | "nextTurn",
	): Promise<void> {
		await this.runLifecycle?.start(correlationId);
		const contentArray: (TextContent | ImageContent)[] =
			typeof content === "string" ? [{ type: "text", text: content }] : content;
		const text = contentArray.find((part): part is TextContent => part.type === "text")?.text ?? "";
		this.agent.publishEvent({
			type: this.triggerEvent,
			payload: { text, sender, content: contentArray, ...(delivery ? { delivery } : {}) },
			correlationId,
			isError: false,
		});
	}

	private handleReply(event: CommandMessage): void {
		const text = typeof event.payload.text === "string" ? event.payload.text : "";
		const sender = typeof event.payload.sender === "string" ? event.payload.sender : "agent";
		const pending = this.pending.get(event.correlationId);
		const complete = this.runLifecycle?.complete(event.correlationId) ?? Promise.resolve();
		void complete.then(
			() => {
				this.onReply(text, sender);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(event.correlationId);
				pending.resolve(text);
			},
			(error: unknown) => {
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(event.correlationId);
				pending.reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	}
}
