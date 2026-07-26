import type { EventHandlerCtx, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { ContextPipeline, ContextPipelineResult } from "@dpopsuev/alef-kernel/context-assembly";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { Message, Tool } from "@dpopsuev/alef-ai/types";

type NotificationBus = EventHandlerCtx["bus"]["notification"];

/** Keeps context mutation synchronous with the model call that consumes it. */
export async function runContextPipeline(
	pipeline: ContextPipeline,
	notification: NotificationBus,
	correlationId: string,
	messages: Message[],
	tools: ToolDefinition[],
	turn: number,
): Promise<ContextPipelineResult> {
	const startedAt = Date.now();
	traceEvent("llm:context:enter", { turn });
	const result = await pipeline.run({ messages, tools, turn });
	for (const injection of result.injections) {
		notification.publish({ type: "context.injection", payload: { ...injection }, correlationId });
	}
	traceEvent("llm:context:exit", {
		turn,
		elapsedMs: Date.now() - startedAt,
		modified: result.injections.length > 0 || result.tools !== tools,
	});
	return result;
}

/** Keeps raw definitions and provider schemas aligned after every stage. */
export function applyContextPipelineResult(
	result: ContextPipelineResult,
	messages: Message[],
	tools: Tool[],
	toolDefinitions: ToolDefinition[],
	nameMap: Map<string, string>,
	buildTools: (definitions: readonly ToolDefinition[], nameMap: Map<string, string>) => Tool[],
): void {
	if (result.messages) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Kernel stages stay AI-package agnostic; the reasoner owns this conversion.
		const nextMessages = result.messages as Message[];
		messages.splice(0, messages.length, ...nextMessages);
	}
	if (result.tools) {
		toolDefinitions.splice(0, toolDefinitions.length, ...result.tools);
		tools.splice(0, tools.length, ...buildTools(toolDefinitions, nameMap));
	}
}
