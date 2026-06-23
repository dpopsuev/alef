import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { InProcessNerve } from "@dpopsuev/alef-kernel/bus";
import type { BusObserver } from "@dpopsuev/alef-runtime";

/**
 * TurnDriver — event/llm.input → command/llm.response request-reply.
 *
 * Test double for AgentController. Drives an organ-llm adapter on a bare bus
 * without pulling in agent-controller. Keeps organ-llm tests dependency-free.
 *
 * Tools are included in the trigger event payload so organ-llm can build its
 * name map without needing a getTools() callback.
 *
 * Usage:
 *   const nerve = new InProcessNerve();
 *   const driver = new TurnDriver(nerve);
 *   const unmount = createAgentLoop({ ... }).mount(nerve.asBus());
 *   const reply = await driver.send("hello");
 *   unmount();
 */
export class TurnDriver {
	private readonly tools: readonly ToolDefinition[];

	constructor(
		private readonly nerve: InProcessNerve,
		private readonly triggerEvent = "llm.input",
		private readonly replyEvent = "llm.response",
		tools?: readonly ToolDefinition[],
	) {
		this.tools = tools ?? [];
	}

	send(text: string, sender = "human", timeoutMs = 5_000): Promise<string> {
		const correlationId = randomUUID();
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error(`TurnDriver.send timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const off = this.nerve.asBus().command.subscribe(this.replyEvent, (event) => {
				if (event.correlationId !== correlationId) return;
				clearTimeout(timer);
				off();
				resolve(typeof event.payload.text === "string" ? event.payload.text : "");
			});
			this.nerve.asBus().event.publish({
				type: this.triggerEvent,
				correlationId,
				payload: { text, sender, tools: this.tools },
				isError: false,
			});
		});
	}

	receive(text: string, sender = "human"): string {
		const correlationId = randomUUID();
		this.nerve.asBus().event.publish({
			type: this.triggerEvent,
			correlationId,
			payload: { text, sender, tools: this.tools },
			isError: false,
		});
		return correlationId;
	}

	observe(observer: BusObserver): () => void {
		const offs = [
			this.nerve.onAnyCommand((event) => observer.onCommand(event)),
			this.nerve.onAnyEvent((event) => observer.onEvent(event)),
		];
		return () => {
			for (const off of offs) off();
		};
	}
}
