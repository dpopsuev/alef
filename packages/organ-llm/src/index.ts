import { type Api, type AssistantMessage, type Message, type Model, streamSimple, type Tool } from "@dpopsuev/alef-ai";
import type { CerebrumHandlerCtx, Nerve, Organ, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";
import { defineCerebrumOrgan } from "@dpopsuev/alef-spine";

const DIALOG_MESSAGE = "dialog.message";

export interface LLMOrganOptions {
	model: Model<Api>;
	apiKey?: string;
	timeoutMs?: number;
	maxRetries?: number;
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

	// Turn loop — quiescence termination, fan-out tool calls
	while (true) {
		const stream = streamSimple(
			options.model,
			{ messages, tools },
			{ apiKey: options.apiKey, timeoutMs, maxRetries },
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
