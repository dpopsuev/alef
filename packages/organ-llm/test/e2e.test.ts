/**
 * organ-llm real-LLM E2E — proves the LLM turn loop.
 *
 * Uses a stub tool that returns a fixed unguessable token so the test
 * verifies tool dispatch, result injection into context, and LLM reply —
 * without importing any other organ package.
 */

import { randomUUID } from "node:crypto";
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { createE2eSession, HAVE_REAL_LLM } from "@dpopsuev/alef-testkit";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe.skipIf(!HAVE_REAL_LLM)("organ-llm — real LLM E2E", { tags: ["real-llm"] }, () => {
	it("LLM organ dispatches a tool call and uses the result in its reply", async () => {
		const token = randomUUID();

		const tokenOrgan = defineOrgan(
			"token",
			{
				motor: {
					"token.get": typedAction(
						{
							name: "token.get",
							description: "Returns the secret token. Call this tool to retrieve it.",
							inputSchema: z.object({}),
						},
						async () => withDisplay({ token }, { text: token, mimeType: "text/plain" }),
					),
				},
			},
			{
				description: "Provides a secret token via token.get.",
				directives: ["Call token.get to retrieve the secret token when asked."],
			},
		);

		const session = createE2eSession([tokenOrgan]);
		const { reply, events } = await session.send("Call token.get and tell me the exact token value.");

		expect(reply).toContain(token);
		expect(events.some((e) => e.type === "tool-start" && e.name.includes("token"))).toBe(true);
		expect(events.some((e) => e.type === "tool-end" && e.ok)).toBe(true);
		session.dispose();
	}, 60_000);
});
