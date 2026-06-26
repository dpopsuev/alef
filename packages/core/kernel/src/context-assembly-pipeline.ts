import type { Adapter, ToolDefinition } from "./adapter-interface.js";
import type { ContextAssemblyHandler, PipelineContributions } from "./contributions.js";
import type { Bus, CommandMessage, EventMessage } from "./messages.js";

export function createContextAssemblyPipeline(): Adapter & {
	getSchemaResolver(): ((toolName: string) => ToolDefinition | undefined) | undefined;
	addStage(name: string, handler: ContextAssemblyHandler): void;
} {
	const stages = new Map<string, ContextAssemblyHandler>();
	const schemaResolvers = new Map<string, (toolName: string) => ToolDefinition | undefined>();

	return {
		name: "context.assembly.pipeline",
		tools: [],
		subscriptions: { command: ["context.assemble"], event: ["adapter.loaded", "adapter.unloaded"], notification: [] },
		sources: [],
		description:
			"Ordered context.assemble pipeline — collects ContextAssemblyHandler and schema-resolver contributions from event/adapter.loaded.",
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
				const contributions = event.payload.contributions as PipelineContributions | undefined;
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

					for (const stage of stages.values()) {
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
						if (out.messages) messages = out.messages;
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- pipeline stage output tools are ToolDefinition[]
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
