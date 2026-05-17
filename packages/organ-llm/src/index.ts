import {
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	streamSimple,
	type ThinkingLevel,
	type Tool,
} from "@dpopsuev/alef-ai";
import type { CerebrumHandlerCtx, Nerve, Organ, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";
import { defineCerebrumOrgan } from "@dpopsuev/alef-spine";

const DIALOG_MESSAGE = "dialog.message";

export interface LLMOrganOptions {
	model: Model<Api>;
	apiKey?: string;
	timeoutMs?: number;
	maxRetries?: number;
	/**
	 * Extended thinking level. Requires a model that supports reasoning
	 * (e.g. claude-3-7-sonnet-20250219). Default: off (no thinking).
	 */
	thinking?: ThinkingLevel;
	/**
	 * Auto-compaction threshold: fraction of the model's context window at which
	 * conversation history is summarised. Range 0–1. Default: 0.8 (80%).
	 * Set 0 to disable compaction.
	 */
	compactionThreshold?: number;
	/**
	 * Called when compaction runs, with the summary text produced.
	 * Use to notify the user or persist the compaction event.
	 */
	onCompact?: (summary: string) => void;
}

// ---------------------------------------------------------------------------
// Compaction — summarise conversation history when context fills
// ---------------------------------------------------------------------------

async function compact(messages: Message[], options: LLMOrganOptions): Promise<string | null> {
	// Send just the non-system messages to the LLM with a summarise prompt.
	const toSummarise = messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
	if (toSummarise.length < 4) return null;

	const summaryPrompt: Message = {
		role: "user",
		content:
			"Summarise the conversation above in 3–5 sentences. Capture: what the user asked, what was done, " +
			"what was found or changed, and any open questions. Be concrete — include file names and key decisions.",
		timestamp: Date.now(),
	};

	try {
		const stream = streamSimple(
			options.model,
			{ messages: [...toSummarise, summaryPrompt], tools: [] },
			{ apiKey: options.apiKey, timeoutMs: options.timeoutMs ?? 60_000, maxRetries: 1 },
		);
		let summary = "";
		for await (const evt of stream) {
			if (evt.type === "done") {
				summary = evt.message.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("");
			}
		}
		return summary || null;
	} catch {
		return null; // compaction is best-effort; never block the main loop
	}
}

// ---------------------------------------------------------------------------
// Core loop — pure function, receives ctx from framework
// ---------------------------------------------------------------------------

async function runLLMLoop(ctx: CerebrumHandlerCtx, options: LLMOrganOptions): Promise<void> {
	const payload = ctx.payload as {
		messages?: readonly unknown[];
		tools?: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[];
		text?: string;
		sender?: string;
	};

	// Build initial messages from payload
	const rawMessages =
		payload.messages ?? (payload.text ? [{ role: "user", content: payload.text, timestamp: Date.now() }] : []);

	// Anthropic tool names must match ^[a-zA-Z0-9_-]{1,128}$.
	// Motor event types use dots (fs.read, shell.exec) — sanitize for the API
	// and keep a reverse map to recover the Motor event type from the LLM's response.
	const motorNameByLlmName = new Map<string, string>();
	const tools: Tool[] = (payload.tools ?? []).map((t) => {
		const llmName = t.name.replace(/\./g, "_");
		motorNameByLlmName.set(llmName, t.name);
		return { name: llmName, description: t.description, parameters: t.inputSchema };
	});
	const toMotorName = (llmName: string): string => motorNameByLlmName.get(llmName) ?? llmName;

	const messages: Message[] = (rawMessages as Message[]).map((m) => {
		const base =
			"timestamp" in m && typeof (m as { timestamp?: unknown }).timestamp === "number"
				? (m as Message)
				: ({ ...(m as object), timestamp: Date.now() } as Message);
		// Normalize assistant messages: plain-string content → content-block array.
		// DialogOrgan stores replies as { role: "assistant", content: "text" } but
		// Anthropic requires content: [{ type: "text", text: "..." }].
		if (base.role === "assistant" && typeof (base as { content?: unknown }).content === "string") {
			const text = (base as unknown as { content: string }).content;
			return { ...base, content: [{ type: "text", text }] } as Message;
		}
		return base;
	});

	const { correlationId, motor, sense } = ctx;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const maxRetries = options.maxRetries ?? 3;
	const compactionThreshold = options.compactionThreshold ?? 0.8;

	// Auto-compaction: summarise when estimated token usage crosses the threshold.
	if (compactionThreshold > 0 && options.model.contextWindow > 0) {
		const estimatedTokens = Math.ceil(
			messages.reduce((n, m) => {
				const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
				return n + Math.ceil(content.length / 4);
			}, 0),
		);
		const limit = Math.floor(options.model.contextWindow * compactionThreshold);
		if (estimatedTokens > limit && messages.length > 4) {
			const summary = await compact(messages, options);
			if (summary) {
				// Replace history with a summary sentinel + recent messages.
				const recent = messages.slice(-4);
				messages.length = 0;
				messages.push({
					role: "user",
					content: `[Conversation summary — earlier context compacted]\n${summary}`,
					timestamp: Date.now(),
				} as Message);
				messages.push(...recent);
				options.onCompact?.(summary);
			}
		}
	}

	// Turn loop — quiescence termination, fan-out tool calls
	while (true) {
		const stream = streamSimple(
			options.model,
			{ messages, tools },
			{
				apiKey: options.apiKey,
				timeoutMs,
				maxRetries,
				...(options.thinking ? { reasoning: options.thinking } : {}),
			},
		);

		let finalMessage: AssistantMessage | undefined;
		const pendingCalls: Array<{ name: string; args: Record<string, unknown>; id: string }> = [];

		for await (const evt of stream) {
			if (evt.type === "toolcall_end") {
				pendingCalls.push({
					name: evt.toolCall.name,
					args: evt.toolCall.arguments as Record<string, unknown>,
					id: evt.toolCall.id,
				});
			} else if (evt.type === "done") {
				finalMessage = evt.message;
			} else if (evt.type === "error") {
				finalMessage = evt.error;
			}
		}

		if (!finalMessage) break;
		messages.push(finalMessage);

		// Quiescence — no tool calls, or LLM called dialog.message as its reply tool.
		// pendingCalls have LLM names (underscored) — resolve to Motor event types.
		const replyCall = pendingCalls.find((tc) => toMotorName(tc.name) === DIALOG_MESSAGE);
		const toolCalls = pendingCalls.filter((tc) => toMotorName(tc.name) !== DIALOG_MESSAGE);

		if (toolCalls.length === 0) {
			// Extract reply text: from dialog.message tool args, or from inline text.
			const text =
				(typeof replyCall?.args.text === "string" ? replyCall.args.text : undefined) ?? extractText(finalMessage);
			if (text) {
				motor.publish({ type: DIALOG_MESSAGE, payload: { text }, correlationId, timestamp: Date.now() });
			}
			break;
		}

		// Fan-out: real tool calls (not dialog.message) simultaneously.
		const results = await Promise.all(
			toolCalls.map((tc) => {
				const motorType = toMotorName(tc.name);
				motor.publish({
					type: motorType,
					payload: { ...tc.args, toolCallId: tc.id },
					correlationId,
					timestamp: Date.now(),
				});
				return waitForToolResult(sense, motorType, tc.id, correlationId);
			}),
		);

		for (let i = 0; i < toolCalls.length; i++) {
			const tc = toolCalls[i];
			const result = results[i];
			messages.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: toMotorName(tc.name),
				content: [{ type: "text", text: payloadToText(result.payload, result.isError, result.errorMessage) }],
				isError: result.isError,
				timestamp: Date.now(),
			});
		}
	}
}

function waitForToolResult(
	sense: CerebrumHandlerCtx["sense"],
	toolName: string,
	toolCallId: string,
	correlationId: string,
): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const off = sense.subscribe(toolName, (event) => {
			if (event.payload.toolCallId === toolCallId && event.correlationId === correlationId) {
				off();
				resolve(event);
			}
		});
	});
}

function payloadToText(payload: Record<string, unknown>, isError: boolean, errorMessage?: string): string {
	if (isError) return errorMessage ?? JSON.stringify(payload);
	if (typeof payload.content === "string") return payload.content;
	if (typeof payload.text === "string") return payload.text;
	const { toolCallId: _id, isFinal: _f, ...rest } = payload;
	return JSON.stringify(rest);
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

// ---------------------------------------------------------------------------
// Factory — now two lines
// ---------------------------------------------------------------------------

export function createLLMOrgan(options: LLMOrganOptions): Organ {
	return defineCerebrumOrgan("llm", {
		[DIALOG_MESSAGE]: { handle: (ctx) => runLLMLoop(ctx, options) },
	});
}

// Backward-compat class export — delegates to factory
export class LLMOrgan {
	private readonly organ: Organ;
	readonly name = "llm";
	readonly tools = [] as const;
	// Delegated from the inner defineCerebrumOrgan — always sense/dialog.message.
	get subscriptions() {
		return this.organ.subscriptions;
	}

	constructor(options: LLMOrganOptions) {
		this.organ = createLLMOrgan(options);
	}

	mount(nerve: Nerve): () => void {
		return this.organ.mount(nerve);
	}
}

// Re-export for consumers that import the type
export type { ToolDefinition };
