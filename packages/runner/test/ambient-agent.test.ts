/**
 * Ambient agent — Cerebrum driven by a non-dialog sense event.
 * No DialogOrgan, no dialog.message, no human input.
 */

import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai";
import { Cerebrum } from "@dpopsuev/alef-organ-llm";
import { InProcessNerve } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";

const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

describe("ambient agent", () => {
	it("sense/file.changed triggers a turn; motor/file.action carries the reply", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("run linter")]);

		const nerve = new InProcessNerve();
		const llm = new Cerebrum({
			model: faux.getModel(),
			apiKey: "faux-key",
			triggerEvent: "file.changed",
			replyEvent: "file.action",
		});
		unmounts.push(llm.mount(nerve.asNerve()));

		const received: string[] = [];
		nerve.asNerve().motor.subscribe("file.action", (event) => {
			const text = typeof event.payload.text === "string" ? event.payload.text : "";
			if (text) received.push(text);
		});

		nerve.asNerve().sense.publish({
			type: "file.changed",
			correlationId: randomUUID(),
			payload: { text: "src/auth.ts changed" },
			isError: false,
		});

		await new Promise<void>((r) => setTimeout(r, 2_000));

		expect(received).toEqual(["run linter"]);
	}, 6_000);
});
