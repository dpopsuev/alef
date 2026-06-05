import { randomUUID } from "node:crypto";
import type { InProcessNerve, ToolDefinition } from "@dpopsuev/alef-kernel";
import { DIALOG_MESSAGE } from "@dpopsuev/alef-organ-dialog";
import type { BusObserver } from "@dpopsuev/alef-runtime";
import { z } from "zod";

/**
 * The tool definition Cerebrum needs in its getTools() so the LLM name
 * "dialog_message" maps back to the motor event "dialog.message".
 * Pass this in the getTools array when constructing Cerebrum in tests
 * that use TurnDriver instead of DialogOrgan.
 */
export const DIALOG_MESSAGE_TOOL: ToolDefinition = {
	name: DIALOG_MESSAGE,
	description: "Send a message.",
	inputSchema: z.object({ text: z.string() }),
};

/**
 * TurnDriver — sense/dialog.message → motor/dialog.message request-reply.
 *
 * Test double for DialogOrgan. Drives a Cerebrum organ on a bare nerve
 * without pulling in organ-dialog. Keeps organ-llm tests dependency-free.
 *
 * Usage:
 *   const nerve = new InProcessNerve();
 *   const driver = new TurnDriver(nerve);
 *   const unmount = new Cerebrum({ ..., getTools: () => [DIALOG_MESSAGE_TOOL] }).mount(nerve.asNerve());
 *   const reply = await driver.send("hello");
 *   unmount();
 */
export class TurnDriver {
	constructor(
		private readonly nerve: InProcessNerve,
		private readonly triggerEvent = DIALOG_MESSAGE,
		private readonly replyEvent = DIALOG_MESSAGE,
	) {}

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
				payload: { text, sender },
				isError: false,
			});
		});
	}

	receive(text: string, sender = "human"): string {
		const correlationId = randomUUID();
		this.nerve.asNerve().sense.publish({
			type: this.triggerEvent,
			correlationId,
			payload: { text, sender },
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
