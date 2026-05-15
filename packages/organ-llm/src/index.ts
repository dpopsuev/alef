import { type Api, type AssistantMessage, type Message, type Model, streamSimple, type Tool } from "@dpopsuev/alef-ai";
import type { CerebrumHandlerCtx, CerebrumOrgan, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";
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
	const tools: Tool[] = (payload.tools ?? []).map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.inputSchema,
	}));

	const messages: Message[] = (rawMessages as Message[]).map((m) => {
		if ("timestamp" in m && typeof (m as { timestamp?: unknown }).timestamp === "number") return m;
		return { ...(m as object), timestamp: Date.now() } as Message;
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

		// Quiescence — emit inline text if present
		if (pendingCalls.length === 0) {
			const text = extractText(finalMessage);
			if (text) {
				motor.publish({ type: DIALOG_MESSAGE, payload: { text }, correlationId, timestamp: Date.now() });
			}
			break;
		}

		// Fan-out: all tool calls simultaneously
		const results = await Promise.all(
			pendingCalls.map((tc) => {
				motor.publish({
					type: tc.name,
					payload: { ...tc.args, toolCallId: tc.id },
					correlationId,
					timestamp: Date.now(),
				});
				return waitForToolResult(sense, tc.name, tc.id, correlationId);
			}),
		);

		for (let i = 0; i < pendingCalls.length; i++) {
			const tc = pendingCalls[i];
			const result = results[i];
			messages.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
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

export function createLLMOrgan(options: LLMOrganOptions): CerebrumOrgan {
	return defineCerebrumOrgan("llm", {
		[DIALOG_MESSAGE]: { handle: (ctx) => runLLMLoop(ctx, options) },
	});
}

// Backward-compat class export — delegates to factory
export class LLMOrgan {
	private readonly organ: CerebrumOrgan;
	readonly kind = "cerebrum" as const;
	readonly name = "llm";
	readonly tools = [] as const;

	constructor(options: LLMOrganOptions) {
		this.organ = createLLMOrgan(options);
	}

	mount(nerve: Parameters<CerebrumOrgan["mount"]>[0]): ReturnType<CerebrumOrgan["mount"]> {
		return this.organ.mount(nerve);
	}
}

// Re-export for consumers that import the type
export type { ToolDefinition };
