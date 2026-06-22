/**
 * Subagent context awareness tests.
 *
 * Verifies that subagents receive critical context (date, cwd) in their
 * system prompt — not just the parent agent.
 */

import { createOrgan } from "@dpopsuev/alef-adapter-fs";
import type { Context } from "@dpopsuev/alef-llm";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-llm";
import { InProcessStrategy } from "@dpopsuev/alef-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { buildSubagentFactory } from "../src/subagent-factory.js";

describe("subagent context awareness", { tags: ["unit"] }, () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("subagent system prompt includes current date", async () => {
		const faux = registerFauxProvider();
		disposes.push(() => faux.unregister());

		let capturedSystemPrompt: string | undefined;

		faux.setResponses([
			(ctx: Context) => {
				capturedSystemPrompt = ctx.systemPrompt;
				return fauxAssistantMessage("Done.");
			},
		]);

		const today = new Date().toISOString().split("T")[0];
		const fsOrgan = createOrgan({ cwd: "/tmp" });
		const basePrompt = "You are a test agent.";
		const factory = buildSubagentFactory({ model: faux.getModel(), baseSystemPrompt: basePrompt });
		const strategy = new InProcessStrategy([fsOrgan], factory, basePrompt);

		await strategy.send({ text: "What year is it?" });

		expect(capturedSystemPrompt).toBeDefined();
		expect(capturedSystemPrompt).toContain(today);
	}, 15_000);

	it("subagent system prompt includes cwd context", async () => {
		const faux = registerFauxProvider();
		disposes.push(() => faux.unregister());

		let capturedSystemPrompt: string | undefined;

		faux.setResponses([
			(ctx: Context) => {
				capturedSystemPrompt = ctx.systemPrompt;
				return fauxAssistantMessage("Done.");
			},
		]);

		const fsOrgan = createOrgan({ cwd: "/home/test/project" });
		const factory = buildSubagentFactory({ model: faux.getModel() });
		const session = factory({ organs: [fsOrgan], systemPrompt: "You are a helper." });
		disposes.push(() => session.dispose());

		await session.send("Hello", "human", 10_000);

		expect(capturedSystemPrompt).toBeDefined();
		expect(capturedSystemPrompt).toContain("Date:");
	}, 15_000);
});
