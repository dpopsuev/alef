import type {
	Adapter,
	ContextAssemblyHandler,
	MotorEvent,
	Nerve,
	PipelineContributions,
	SenseEvent,
	ToolDefinition,
} from "./buses.js";

export function createContextAssemblyPipeline(): Adapter & {
	getSchemaResolver(): ((toolName: string) => ToolDefinition | undefined) | undefined;
	addStage(name: string, handler: ContextAssemblyHandler): void;
} {
	const stages = new Map<string, ContextAssemblyHandler>();
	const schemaResolvers = new Map<string, (toolName: string) => ToolDefinition | undefined>();

	return {
		name: "context.assembly.pipeline",
		tools: [],
		subscriptions: { motor: ["context.assemble"], sense: ["organ.loaded", "organ.unloaded"] },
		sources: [],
		description:
			"Ordered context.assemble pipeline — collects ContextAssemblyHandler and schema-resolver contributions from sense/organ.loaded.",
		contributions: {
			port: { name: "context_assembly", eventPattern: "motor/context.assemble", cardinality: "ordered-pipeline" },
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
		mount(nerve: Nerve): () => void {
			const unsubLoaded = nerve.sense.subscribe("organ.loaded", (event: SenseEvent) => {
				const contributions = event.payload.contributions as PipelineContributions | undefined;
				const name = event.payload.name as string;
				if (contributions?.["context.assemble"]) stages.set(name, contributions["context.assemble"]);
				if (contributions?.["schema-resolver"]) schemaResolvers.set(name, contributions["schema-resolver"]);
			});

			const unsubUnloaded = nerve.sense.subscribe("organ.unloaded", (event: SenseEvent) => {
				const name = event.payload.name as string;
				stages.delete(name);
				schemaResolvers.delete(name);
			});

			const unsubAssemble = nerve.motor.subscribe("context.assemble", (event: MotorEvent) => {
				void (async () => {
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
							nerve.sense.publish({
								type: "context.assemble",
								correlationId: event.correlationId,
								payload: { abort: true },
								isError: false,
							});
							return;
						}
						if (out.messages) messages = out.messages;
						if (out.tools) tools = out.tools as ToolDefinition[];
						if (out.skip) {
							nerve.sense.publish({
								type: "context.assemble",
								correlationId: event.correlationId,
								payload: { skip: true, reply: out.reply ?? "", messages, tools },
								isError: false,
							});
							return;
						}
					}

					nerve.sense.publish({
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
