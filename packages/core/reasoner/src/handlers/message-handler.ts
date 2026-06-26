import { toolInputToJsonSchema } from "@dpopsuev/alef-kernel/adapter";
import type { Message, Tool } from "@dpopsuev/alef-llm";
import type { z } from "zod";
import { normalizeMessage } from "../retry.js";

type ToolDef = { name: string; description: string; inputSchema: z.ZodTypeAny };

export interface TurnSetup {
	messages: Message[];
	tools: Tool[];
	nameMap: Map<string, string>;
}

export function buildTools(defs: readonly ToolDef[], nameMap: Map<string, string>): Tool[] {
	const seen = new Set<string>();
	const tools: Tool[] = [];
	for (const t of defs) {
		const llmName = t.name.replace(/\./g, "_");
		if (seen.has(llmName)) continue;
		seen.add(llmName);
		nameMap.set(llmName, t.name);
		tools.push({ name: llmName, description: t.description, parameters: toolInputToJsonSchema(t.inputSchema) });
	}
	return tools;
}

export function prepareTurn(payload: {
	messages?: readonly unknown[];
	tools?: readonly { name: string; description: string; inputSchema: unknown }[];
	text?: string;
}): TurnSetup {
	const rawMessages =
		payload.messages ?? (payload.text ? [{ role: "user", content: payload.text, timestamp: Date.now() }] : []);
	const nameMap = new Map<string, string>();
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped bus payload to known tool shape
	const toolDefs = (payload.tools as readonly ToolDef[] | undefined) ?? [];
	const tools = buildTools(toolDefs, nameMap);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped bus payload to Message[]
	const messages = (rawMessages as Message[]).map(normalizeMessage);
	return { messages, tools, nameMap };
}

export function serializeConversationHistory(messages: Message[]): unknown[] {
	return messages
		.filter((m) => (m as { role?: string }).role !== "system")
		.map((m): unknown => {
			const msg = m as { role: string; content: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
			if (msg.role === "toolResult") {
				return {
					role: "toolResult",
					toolCallId: msg.toolCallId,
					toolName: msg.toolName,
					content: msg.content,
					isError: msg.isError,
				};
			}
			return { role: msg.role, content: msg.content };
		});
}
