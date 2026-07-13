import type { Adapter, ToolDefinition } from "./adapter/interface.js";
import type { ContextAssemblyContributions, ContextAssemblyHandler } from "./adapter/contributions.js";
import type { Bus, CommandMessage, EventMessage } from "./bus/messages.js";

/** Metadata describing a context.assemble injection for telemetry and :context. */
export interface ContextInjectionMeta {
	source: string;
	chars: number;
	preview: string;
}

const PREVIEW_CHARS = 160;

/** Build the context assembly adapter that pipelines ContextAssemblyHandler stages before each LLM call. */
export function createContextAssembler(): Adapter & {
	getSchemaResolver(): ((toolName: string) => ToolDefinition | undefined) | undefined;
	addStage(name: string, handler: ContextAssemblyHandler): void;
} {
	const stages = new Map<string, ContextAssemblyHandler>();
	const schemaResolvers = new Map<string, (toolName: string) => ToolDefinition | undefined>();

	return {
		name: "context.assembly",
		tools: [],
		subscriptions: { command: ["context.assemble"], event: ["adapter.loaded", "adapter.unloaded"], notification: [] },
		sources: [],
		description:
			"Context assembler — collects ContextAssemblyHandler and schema-resolver contributions from adapters.",
		contributions: {
			port: { name: "context_assembly", eventPattern: "command/context.assemble", cardinality: "ordered-pipeline" },
		},
		addStage(name: string, handler: ContextAssemblyHandler) {
			stages.set(name, handler);
		},
		getSchemaResolver() {
			if (schemaResolvers.size === 0) return undefined;
			return (toolName: string) => {
				for (const resolver of schemaResolvers.values()) {
					const def = resolver(toolName);
					if (def) return def;
				}
				return undefined;
			};
		},
		mount(bus: Bus): () => void {
			const unsubLoaded = bus.event.subscribe("adapter.loaded", (event: EventMessage) => {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- bus protocol: adapter.loaded payload shape
				const contributions = event.payload.contributions as ContextAssemblyContributions | undefined;
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- bus protocol: adapter.loaded payload shape
				const name = event.payload.name as string;
				if (contributions?.["context.assemble"]) stages.set(name, contributions["context.assemble"]);
				if (contributions?.["schema-resolver"]) schemaResolvers.set(name, contributions["schema-resolver"]);
			});

			const unsubUnloaded = bus.event.subscribe("adapter.unloaded", (event: EventMessage) => {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- bus protocol: adapter.unloaded payload shape
				const name = event.payload.name as string;
				stages.delete(name);
				schemaResolvers.delete(name);
			});

			const unsubAssemble = bus.command.subscribe("context.assemble", (event: CommandMessage) => {
				void (async () => {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- bus protocol: context.assemble command payload shape
					const payload = event.payload as {
						messages: readonly unknown[];
						tools?: ToolDefinition[];
						turn: number;
					};
					let messages: readonly unknown[] = payload.messages;
					let tools: ToolDefinition[] = payload.tools ?? [];

					for (const [stageName, stage] of stages.entries()) {
						const before = messages;
						const out = await stage({ messages, tools, turn: payload.turn });
						if (out.abort) {
							bus.event.publish({
								type: "context.assemble",
								correlationId: event.correlationId,
								payload: { abort: true },
								isError: false,
							});
							return;
						}
						if (out.messages) {
							messages = out.messages;
							const injection = describeMessageDelta(before, messages, stageName);
							if (injection.chars > 0) {
								bus.notification.publish({
									type: "context.injection",
									correlationId: event.correlationId,
									payload: { ...injection },
								});
							}
						}
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- context assembly stage output tools are ToolDefinition[]
						if (out.tools) tools = out.tools as ToolDefinition[];
						if (out.skip) {
							bus.event.publish({
								type: "context.assemble",
								correlationId: event.correlationId,
								payload: { skip: true, reply: out.reply ?? "", messages, tools },
								isError: false,
							});
							return;
						}
					}

					bus.event.publish({
						type: "context.assemble",
						correlationId: event.correlationId,
						payload: { messages, tools },
						isError: false,
					});
				})();
			});

			return () => {
				unsubLoaded();
				unsubUnloaded();
				unsubAssemble();
			};
		},
	};
}
type RawMsg = { role?: string; content?: unknown };

/** Serialize a message content field for injection sizing/preview. */
function messageContentText(message: unknown): string {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- message array element shape check
	const content = (message as RawMsg).content;
	if (typeof content === "string") return content;
	if (content === undefined) return "";
	return JSON.stringify(content);
}

/** Diff before/after message lists into attributable injection metadata. */
export function describeMessageDelta(
	before: readonly unknown[],
	after: readonly unknown[],
	source: string,
): ContextInjectionMeta {
	const beforeRefs = new Set(before);
	const added: string[] = [];
	for (const message of after) {
		if (!beforeRefs.has(message)) {
			added.push(messageContentText(message));
		}
	}
	if (added.length > 0) {
		const text = added.join("\n");
		return {
			source,
			chars: text.length,
			preview: text.slice(0, PREVIEW_CHARS).replace(/\s+/g, " ").trim(),
		};
	}
	const beforeText = before.map(messageContentText).join("\n");
	const afterText = after.map(messageContentText).join("\n");
	if (afterText === beforeText) {
		return { source, chars: 0, preview: "" };
	}
	const chars = Math.max(0, afterText.length - beforeText.length) || afterText.length;
	const previewStart = Math.min(beforeText.length, afterText.length);
	return {
		source,
		chars,
		preview: afterText.slice(previewStart, previewStart + PREVIEW_CHARS).replace(/\s+/g, " ").trim() ||
			afterText.slice(0, PREVIEW_CHARS).replace(/\s+/g, " ").trim(),
	};
}

/**
 * Inject a text block into the message array after the system message.
 * Used by adapters that contribute context via context.assemble (memory, scribe, board).
 * Pass meta.source for caller attribution; the assembler publishes stage name on context.injection.
 */
export function injectContextBlock(
	messages: readonly unknown[],
	block: string,
	_meta?: { source: string },
): unknown[] {
	const result = [...messages];
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- message array element shape check
	const systemIdx = result.findIndex((m) => (m as RawMsg).role === "system");
	const insertAt = systemIdx >= 0 ? systemIdx + 1 : 0;
	result.splice(insertAt, 0, { role: "user", content: block });
	return result;
}

// Re-exports for ./context-assembly subpath consumers
export type {
	ContextAssemblyHandler,
	ContextAssemblyInput,
	ContextAssemblyOutput,
	PortCardinality,
	PortDefinition,
} from "./adapter/contributions.js";
