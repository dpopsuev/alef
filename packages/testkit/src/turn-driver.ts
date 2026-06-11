import { randomUUID } from "node:crypto";
import type { InProcessNerve, ToolDefinition } from "@dpopsuev/alef-kernel";
import type { BusObserver } from "@dpopsuev/alef-runtime";

/**
 * TurnDriver — sense/llm.input → motor/llm.response request-reply.
 *
 * Test double for DialogOrgan. Drives an organ-llm organ on a bare nerve
 * without pulling in organ-dialog. Keeps organ-llm tests dependency-free.
 *
 * Tools are included in the trigger event payload so organ-llm can build its
 * name map without needing a getTools() callback.
 *
 * Usage:
 *   const nerve = new InProcessNerve();
 *   const driver = new TurnDriver(nerve);
 *   const unmount = createAgentLoop({ ... }).mount(nerve.asNerve());
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
			const off = this.nerve.asNerve().motor.subscribe(this.replyEvent, (event) => {
				if (event.correlationId !== correlationId) return;
				clearTimeout(timer);
				off();
				resolve(typeof event.payload.text === "string" ? event.payload.text : "");
			});
			this.nerve.asNerve().sense.publish({
				type: this.triggerEvent,
				correlationId,
				payload: { text, sender, tools: this.tools },
				isError: false,
			});
		});
	}

	receive(text: string, sender = "human"): string {
		const correlationId = randomUUID();
		this.nerve.asNerve().sense.publish({
			type: this.triggerEvent,
			correlationId,
			payload: { text, sender, tools: this.tools },
			isError: false,
		});
		return correlationId;
	}

	observe(observer: BusObserver): () => void {
		const offs = [
			this.nerve.onAnyMotor((event) => observer.onMotorEvent(event)),
			this.nerve.onAnySense((event) => observer.onSenseEvent(event)),
		];
		return () => {
			for (const off of offs) off();
		};
	}
}
