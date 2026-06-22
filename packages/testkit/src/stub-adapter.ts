import { type Adapter, buildSense, type MotorEvent, type Nerve, type ToolDefinition } from "@dpopsuev/alef-kernel";

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
		mount(nerve: Nerve): () => void {
			const offs = tools.map((t) =>
				nerve.motor.subscribe(t.name, (event: MotorEvent) => {
					void handler(event.type, event.payload).then((result) => {
						nerve.sense.publish(buildSense(event, result));
					});
				}),
			);
			return () => {
				for (const off of offs) off();
			};
		},
	};
}
