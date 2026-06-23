/**
 * HttpAgentClient — bridges the runner's HTTP/SSE surface to the web-ui Agent interface.
 *
 * Protocol:
 *   POST {baseUrl}/message  { text: string }  → 202
 *   GET  {baseUrl}/events   text/event-stream
 *     event: motor/llm.response
 *     data:  { bus, type, correlationId, payload: { text, role }, timestamp }
 *
 * The runner handles model selection, API keys, and tool execution server-side.
 * This client is read-only from those perspectives.
 */

import type { Agent, AgentEvent, AgentMessage, AgentState, ThinkingLevel } from "@dpopsuev/alef-web-ui";

class MutableAgentState implements AgentState {
	systemPrompt = "";
	model: any = { provider: "runner", id: "runner", name: "Alef Runner", reasoning: false, contextWindow: 200_000 };
	thinkingLevel: ThinkingLevel = "off";
	isStreaming = false;
	streamingMessage: AgentMessage | undefined = undefined;
	pendingToolCalls: ReadonlySet<string> = new Set();
	errorMessage: string | undefined = undefined;

	private _tools: any[] = [];
	private _messages: AgentMessage[] = [];

	get tools() {
		return this._tools;
	}
	set tools(v: any[]) {
		this._tools = [...v];
	}
	get messages() {
		return this._messages;
	}
	set messages(v: AgentMessage[]) {
		this._messages = [...v];
	}

	push(message: AgentMessage): void {
		this._messages = [...this._messages, message];
	}
}

export class HttpAgentClient implements Agent {
	readonly state: MutableAgentState;

	private readonly baseUrl: string;
	private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
	private eventSource: EventSource | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.state = new MutableAgentState();
		this.connect();
	}

	private connect(): void {
		this.eventSource?.close();
		const source = new EventSource(`${this.baseUrl}/events`);

		source.addEventListener("command/llm.response", (e: Event) => {
			const raw = JSON.parse((e as MessageEvent).data) as {
				payload: { text?: string; role?: string };
			};
			const text = raw.payload?.text;
			if (!text || raw.payload.role === "human") return;

			const message: AgentMessage = { role: "assistant", content: [{ type: "text", text }] } as any;
			this.state.push(message);
			this.state.isStreaming = false;
			this.state.pendingToolCalls = new Set();

			this.emit({ type: "message_start", message });
			this.emit({ type: "message_end", message });
			this.emit({ type: "turn_end", message, toolResults: [] });
			this.emit({ type: "agent_end", messages: this.state.messages });
		});

		source.onerror = () => {
			source.close();
			if (this.reconnectTimer) return;
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null;
				this.connect();
			}, 3_000);
		};

		this.eventSource = source;
	}

	subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	async prompt(input: string | AgentMessage): Promise<void> {
		const text =
			typeof input === "string" ? input : ((input as any).content?.find((c: any) => c.type === "text")?.text ?? "");
		if (!text.trim()) return;

		const userMessage: AgentMessage = { role: "user", content: [{ type: "text", text }] } as any;
		this.state.push(userMessage);
		this.state.isStreaming = true;

		this.emit({ type: "agent_start" });
		this.emit({ type: "turn_start" });
		this.emit({ type: "message_start", message: userMessage });
		this.emit({ type: "message_end", message: userMessage });

		try {
			await fetch(`${this.baseUrl}/message`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text }),
			});
		} catch (err) {
			this.state.isStreaming = false;
			this.state.errorMessage = err instanceof Error ? err.message : "Network error";
			this.emit({ type: "agent_end", messages: this.state.messages });
		}
	}

	abort(): void {
		this.state.isStreaming = false;
		this.emit({ type: "agent_end", messages: this.state.messages });
	}

	steer(_message: AgentMessage): void {
		// Not supported over HTTP.
	}

	dispose(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.eventSource?.close();
		this.eventSource = null;
	}

	private emit(event: AgentEvent): void {
		for (const listener of this.listeners) void listener(event);
	}
}
