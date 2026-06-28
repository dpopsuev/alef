/**
 * Subagent tool schema injection test.
 *
 * Verifies that subagents created by buildSubagentFactory receive tool schemas
 * via the LLM API's `tools` parameter — not just in system prompt text.
 *
 * Without proper tool injection, the LLM falls back to training-data XML syntax
 * (<read_file>, <bash>) instead of structured tool_use blocks.
 */

import { buildSubagentFactory } from "@dpopsuev/alef-agent/subagent-factory";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import type { Context } from "@dpopsuev/alef-ai/types";
import { InProcessStrategy } from "@dpopsuev/alef-engine/in-process";
import { createAdapter } from "@dpopsuev/alef-tool-fs";
import { afterEach, describe, expect, it } from "vitest";

describe("subagent tool schema injection", { tags: ["unit"] }, () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("LLM API call includes tool schemas from loaded organs", async () => {
		const faux = registerFauxProvider();
		disposes.push(() => faux.unregister());

		let capturedContext: Context | undefined;

		faux.setResponses([
			(ctx: Context) => {
				capturedContext = ctx;
				return fauxAssistantMessage("Done.");
			},
		]);

		const fsOrgan = createAdapter({ cwd: "/tmp" });
		const factory = buildSubagentFactory({ model: faux.getModel() });
		const session = factory({ adapters: [fsOrgan] });
		disposes.push(() => session.dispose());

		await session.send!("Read the file /tmp/test.txt", 10_000);

		expect(capturedContext).toBeDefined();
		expect(capturedContext!.tools).toBeDefined();
		expect(capturedContext!.tools!.length).toBeGreaterThan(0);

		const toolNames = capturedContext!.tools!.map((t) => t.name);
		expect(toolNames).toContain("fs_read");
	}, 15_000);

	it("InProcessStrategy subagent receives tool schemas", async () => {
		const faux = registerFauxProvider();
		disposes.push(() => faux.unregister());

		let capturedTools: unknown[] | undefined;

		faux.setResponses([
			(ctx: Context) => {
				capturedTools = ctx.tools;
				return fauxAssistantMessage("Explored.");
			},
		]);

		const fsOrgan = createAdapter({ cwd: "/tmp" });
		const factory = buildSubagentFactory({ model: faux.getModel() });
		const strategy = new InProcessStrategy([fsOrgan], factory, "You are a test agent.");

		const reply = await strategy.send({ text: "List files" });

		expect(reply).toBe("Explored.");
		expect(capturedTools).toBeDefined();
		expect(capturedTools!.length).toBeGreaterThan(0);
	}, 15_000);
});
