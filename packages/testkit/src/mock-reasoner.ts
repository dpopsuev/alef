import type { Nerve, Organ, ToolDefinition } from "@dpopsuev/alef-kernel";

export class MockReasoner implements Organ {
	readonly name = "mock-llm";
	readonly tools: readonly ToolDefinition[] = [];
	readonly subscriptions = { motor: [] as const, sense: ["llm.input"] as const };
	readonly sources = [] as const;

	constructor(private readonly cannedText: string = "mock response") {}

	mount(nerve: Nerve): () => void {
		return nerve.sense.subscribe("llm.input", (event) => {
			nerve.motor.publish({
				type: "llm.response" as const,
				payload: { text: this.cannedText },
				correlationId: event.correlationId,
			});
		});
	}
}
