import { describe, expect, it } from "vitest";
import { getModel } from "../src/models/llm.js";
import { complete } from "../src/stream.js";
import type { Context } from "../src/types.js";
import { skipIfQuotaExceeded, withStatusCapture } from "./api-status.js";
import { HAVE_REAL_LLM } from "./gate.js";

describe.skipIf(!HAVE_REAL_LLM || !process.env.OPENAI_API_KEY)(
	"openai responses cache affinity e2e",
	{ tags: ["real-llm"] },
	() => {
		it("handles direct OpenAI Responses requests with aligned cache-affinity identifiers", { retry: 2 }, async (ctx) => {
			const model = getModel("openai", "gpt-5.4")!;
			const sessionId = "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
			const context: Context = {
				systemPrompt: "You are a helpful assistant. Reply exactly as requested.",
				messages: [
					{
						role: "user",
						content: "Reply with exactly: openai cache affinity e2e success",
						timestamp: Date.now(),
					},
				],
			};

			const capture = withStatusCapture({
				apiKey: process.env.OPENAI_API_KEY!,
				sessionId,
			});
			const response = await complete(model, context, capture.options);
			skipIfQuotaExceeded(ctx, capture.getStatus(), response.errorMessage);

			expect(response.stopReason, response.errorMessage).not.toBe("error");
			expect(response.errorMessage).toBeUndefined();
			expect(response.content.map((block) => (block.type === "text" ? block.text : "")).join("")).toContain(
				"openai cache affinity e2e success",
			);
		});
	},
);
