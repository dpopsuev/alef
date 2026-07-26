import type { Adapter, ToolDefinition } from "./adapter/interface.js";
import type { ContextAssemblyHandler, ContextAssemblyInput, ContextAssemblyOutput } from "./adapter/contributions.js";

/** Keeps context growth attributable without exposing stage internals. */
export interface ContextInjectionMeta {
	source: string;
	chars: number;
	preview: string;
}

const PREVIEW_CHARS = 160;

/** Carries injection attribution without coupling stages to telemetry. */
export interface ContextPipelineResult extends ContextAssemblyOutput {
	readonly injections: readonly ContextInjectionMeta[];
}

/** Keeps context control ordered and awaited without routing it through events. */
export class ContextPipeline {
	private readonly stages = new Map<string, ContextAssemblyHandler>();
	private readonly schemaResolvers = new Map<string, (toolName: string) => ToolDefinition | undefined>();

	constructor(adapters: readonly Adapter[] = []) {
		this.addAdapters(adapters);
	}

	addStage(name: string, handler: ContextAssemblyHandler): void {
		this.stages.set(name, handler);
	}

	addAdapters(adapters: readonly Adapter[]): void {
		for (const adapter of adapters) {
			const stage = adapter.contributions?.["context.stage"];
			if (stage) this.stages.set(adapter.name, stage);
			const resolver = adapter.contributions?.["schema-resolver"];
			if (resolver) this.schemaResolvers.set(adapter.name, resolver);
		}
	}

	resolveSchema(toolName: string): ToolDefinition | undefined {
		for (const resolver of this.schemaResolvers.values()) {
			const definition = resolver(toolName);
			if (definition) return definition;
		}
		return undefined;
	}

	async run(input: ContextAssemblyInput): Promise<ContextPipelineResult> {
		let messages = input.messages;
		let tools = input.tools;
		const injections: ContextInjectionMeta[] = [];
		for (const [stageName, stage] of this.stages) {
			const before = messages;
			const output = await stage({ messages, tools, turn: input.turn });
			if (output.messages) {
				messages = output.messages;
				const injection = describeMessageDelta(before, messages, stageName);
				if (injection.chars > 0) injections.push(injection);
			}
			if (output.tools) tools = output.tools;
			if (output.abort) return { abort: true, messages, tools, injections };
			if (output.skip) {
				return { skip: true, reply: output.reply ?? "", messages, tools, injections };
			}
		}
		return { messages, tools, injections };
	}
}

/** Preserves materialization order independently of bus timing. */
export function createContextPipeline(adapters: readonly Adapter[] = []): ContextPipeline {
	return new ContextPipeline(adapters);
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

/** Keeps injected domain context adjacent to the system prompt. */
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
