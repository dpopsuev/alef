import { describe, expect, it } from "vitest";
import { getModel } from "../src/models/llm.js";
import { stream } from "../src/stream.js";
import type { Context, Model } from "../src/types.js";
import { skipIfQuotaExceeded, withStatusCapture } from "./api-status.js";
import { HAVE_REAL_LLM } from "./gate.js";

function makeContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: `What is ${(Math.random() * 100) | 0} + ${(Math.random() * 100) | 0}? Think step by step.`,
				timestamp: Date.now(),
			},
		],
	};
}

describe.skipIf(!HAVE_REAL_LLM || !process.env.OPENAI_API_KEY)("xhigh reasoning", { tags: ["real-llm"] }, () => {
	describe("codex-max (supports xhigh)", () => {
		// Note: codex models only support the responses API, not chat completions
		it("should work with openai-responses", async (ctx) => {
			const model = getModel("openai", "gpt-5.1-codex-max")!;
			const capture = withStatusCapture({ reasoningEffort: "xhigh" as const });
			const s = stream(model, makeContext(), capture.options);
			let hasThinking = false;

			for await (const event of s) {
				if (event.type === "thinking_start" || event.type === "thinking_delta") {
					hasThinking = true;
				}
			}

			const response = await s.result();
			skipIfQuotaExceeded(ctx, capture.getStatus(), response.errorMessage);
			expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
			expect(response.content.some((b) => b.type === "text")).toBe(true);
			expect(hasThinking || response.content.some((b) => b.type === "thinking")).toBe(true);
		});
	});

	describe("gpt-5-mini (does not support xhigh)", () => {
		it("should error with openai-responses when using xhigh", async (ctx) => {
			const model = getModel("openai", "gpt-5-mini")!;
			const capture = withStatusCapture({ reasoningEffort: "xhigh" as const });
			const s = stream(model, makeContext(), capture.options);

			for await (const _ of s) {
				// drain events
			}

			const response = await s.result();
			skipIfQuotaExceeded(ctx, capture.getStatus(), response.errorMessage);
			expect(response.stopReason).toBe("error");
			expect(response.errorMessage).toContain("xhigh");
		});

		it("should error with openai-completions when using xhigh", async (ctx) => {
			const { compat: _compat, ...baseModel } = getModel("openai", "gpt-5-mini")!;
			void _compat;
			const model: Model<"openai-completions"> = {
				...baseModel,
				api: "openai-completions",
			};
			const capture = withStatusCapture({ reasoningEffort: "xhigh" as const });
			const s = stream(model, makeContext(), capture.options);

			for await (const _ of s) {
				// drain events
			}

			const response = await s.result();
			skipIfQuotaExceeded(ctx, capture.getStatus(), response.errorMessage);
			expect(response.stopReason).toBe("error");
			expect(response.errorMessage).toContain("xhigh");
		});
	});
});
