import type { Adapter, Bus, ToolDefinition } from "@dpopsuev/alef-kernel";

export class MockReasoner implements Adapter {
	readonly name = "mock-llm";
	readonly tools: readonly ToolDefinition[] = [];
	readonly subscriptions = { motor: [] as const, sense: ["llm.input"] as const };
	readonly sources = [] as const;

	constructor(private readonly cannedText: string = "mock response") {}

	mount(nerve: Bus): () => void {
		return nerve.event.subscribe("llm.input", (event) => {
			nerve.command.publish({
				type: "llm.response" as const,
				payload: { text: this.cannedText },
				correlationId: event.correlationId,
			});
		});
	}
}
