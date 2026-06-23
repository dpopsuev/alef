import { type Adapter, type Bus, buildSense, type CommandMessage, type ToolDefinition } from "@dpopsuev/alef-kernel";

export type StubHandler = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export function defineStubAdapter(name: string, tools: ToolDefinition[], handler: StubHandler): Adapter {
	return {
		name,
		tools,
		description: `Stub organ: ${name}`,
		subscriptions: {
			motor: tools.map((t) => t.name),
			sense: [],
		},
		sources: [],
		mount(nerve: Bus): () => void {
			const offs = tools.map((t) =>
				nerve.command.subscribe(t.name, (event: CommandMessage) => {
					void handler(event.type, event.payload).then((result) => {
						nerve.event.publish(buildSense(event, result));
					});
				}),
			);
			return () => {
				for (const off of offs) off();
			};
		},
	};
}
