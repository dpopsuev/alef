import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { describe, expect, it } from "vitest";
import { ImplStationRunner } from "../src/workflow/station-strategy.js";

describe("ImplStationRunner context pipeline", { tags: ["unit"] }, () => {
	it("runs materialized domain context stages before the station model", async () => {
		const faux = registerFauxProvider();
		let stageRuns = 0;
		const domainAdapter: Adapter = {
			name: "station-context",
			tools: [],
			subscriptions: { command: [], event: [], notification: [] },
			sources: [],
			contributions: {
				"context.stage": async ({ messages }) => {
					stageRuns++;
					return { messages };
				},
			},
			mount: () => () => undefined,
		};
		faux.setResponses([fauxAssistantMessage("done")]);

		try {
			const runner = new ImplStationRunner(faux.getModel(), [domainAdapter]);
			await runner.run({ name: "context-aware", contract: "intent", timeoutMs: 2_000 }, undefined);
			expect(stageRuns).toBe(1);
		} finally {
			faux.unregister();
		}
	});
});
