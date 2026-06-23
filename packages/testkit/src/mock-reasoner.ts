import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";

export class MockReasoner implements Adapter {
	readonly name = "mock-llm";
	readonly tools: readonly ToolDefinition[] = [];
	readonly subscriptions = { command: [] as const, event: ["llm.input"] as const };
	readonly sources = [] as const;

	constructor(private readonly cannedText: string = "mock response") {}

	mount(bus: Bus): () => void {
		return bus.event.subscribe("llm.input", (event) => {
			bus.command.publish({
				type: "llm.response" as const,
				payload: { text: this.cannedText },
				correlationId: event.correlationId,
			});
		});
	}
}
