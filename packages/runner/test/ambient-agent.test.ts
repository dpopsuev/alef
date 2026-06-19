/**
 * Ambient agent — organ-llm driven by a programmatic sense event.
 * No AgentController, no human input — the trigger is published directly.
 */

import { randomUUID } from "node:crypto";
import { InProcessNerve } from "@dpopsuev/alef-kernel";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-llm";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { afterEach, describe, expect, it } from "vitest";

const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

describe("ambient agent", { tags: ["unit"] }, () => {
	it("sense/llm.input triggers a turn without AgentController; motor/llm.response carries the reply", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("run linter")]);

		const nerve = new InProcessNerve();
		const llm = createAgentLoop({
			model: faux.getModel(),
			apiKey: "faux-key",
		});
		unmounts.push(llm.mount(nerve.asNerve()));
		unmounts.push(() => faux.unregister());

		const received: string[] = [];
		nerve.asNerve().motor.subscribe("llm.response", (event) => {
			const text = typeof event.payload.text === "string" ? event.payload.text : "";
			if (text) received.push(text);
		});

		nerve.asNerve().sense.publish({
			type: "llm.input",
			correlationId: randomUUID(),
			payload: { text: "src/auth.ts changed" },
			isError: false,
		});

		await new Promise<void>((r) => setTimeout(r, 2_000));

		expect(received).toEqual(["run linter"]);
	}, 6_000);
});
