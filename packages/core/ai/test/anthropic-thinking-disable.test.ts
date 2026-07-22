import { describe, expect, it } from "vitest";
import { getModel } from "../src/models/llm.js";
import { streamSimple } from "../src/stream.js";
import type { AnthropicMessagesCompat, Api, Context, Model, SimpleStreamOptions } from "../src/types.js";

/** Narrow a generic Model's compat to the Anthropic shape for test assertions. */
function forceAdaptiveThinking(model: Model<Api>): boolean | undefined {
	if (model.api !== "anthropic-messages") return undefined;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- api checked above; compat's conditional type isn't narrowed by control flow
	return (model.compat as AnthropicMessagesCompat | undefined)?.forceAdaptiveThinking;
}

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

function makePayloadCaptureContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<Api>,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const payloadCaptureModel: Model<Api> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makePayloadCaptureContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			return payload;
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

interface RunResult {
	thinkingEventCount: number;
	thinkingCharCount: number;
	text: string;
	contentTypes: string[];
}

function makeE2EContext(): Context {
	return {
		systemPrompt: "You are a precise assistant. Follow the requested output format exactly.",
		messages: [
			{
				role: "user",
				content:
					"Before replying, carefully solve 36863 * 5279 internally. Then reply with the word pong repeated exactly 40 times, separated by single spaces. Do not add any other text.",
				timestamp: Date.now(),
			},
		],
	};
}

function countPongs(text: string): number {
	return text.match(/\bpong\b/gi)?.length ?? 0;
}

async function runWithoutReasoning(model: Model<Api>): Promise<RunResult> {
	const s = streamSimple(model, makeE2EContext(), {
		temperature: 0,
		maxTokens: 160,
	});

	let thinkingEventCount = 0;
	let thinkingCharCount = 0;

	for await (const event of s) {
		if (event.type === "thinking_start" || event.type === "thinking_end") {
			thinkingEventCount += 1;
		}
		if (event.type === "thinking_delta") {
			thinkingEventCount += 1;
			thinkingCharCount += event.delta.length;
		}
	}

	const response = await s.result();
	expect(response.stopReason, response.errorMessage).toBe("stop");

	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();

	return {
		thinkingEventCount,
		thinkingCharCount,
		text,
		contentTypes: response.content.map((block) => block.type),
	};
}

describe("Anthropic thinking disable payload", { tags: ["unit"] }, () => {
	it("sends thinking.type=disabled for budget-based reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-5")!);

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for adaptive reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-6")!);

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for Claude Opus 4.7 when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7")!);

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("uses adaptive thinking for Claude Opus 4.7 when reasoning is enabled", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7")!, { reasoning: "high" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.7", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7")!, { reasoning: "xhigh" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("uses adaptive thinking for Claude Sonnet 5 when reasoning is enabled", async () => {
		const sonnet5: Model<Api> = { ...getModel("anthropic", "claude-opus-4-7")!, id: "claude-sonnet-5" };
		const payload = await capturePayload(sonnet5, { reasoning: "high" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("uses adaptive thinking for Claude Opus 4.8 when reasoning is enabled", async () => {
		const opus48: Model<Api> = { ...getModel("anthropic", "claude-opus-4-7")!, id: "claude-opus-4-8" };
		const payload = await capturePayload(opus48, { reasoning: "high" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});
});

describe("Adaptive thinking flag assignment", { tags: ["unit"] }, () => {
	it("sets compat.forceAdaptiveThinking on the bundled snapshot for Claude Opus 4.7", () => {
		const model = getModel("anthropic", "claude-opus-4-7")!;
		expect(forceAdaptiveThinking(model)).toBe(true);
	});

	it("sets compat.forceAdaptiveThinking when merging a live models.dev entry for Claude Sonnet 5", async () => {
		const { mergeModelsDevEntries } = await import("../src/models/models-snapshot.js");
		const registry = new Map<string, Map<string, Model<Api>>>();

		mergeModelsDevEntries(registry, [{ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" }]);

		const merged = registry.get("anthropic")?.get("claude-sonnet-5");
		expect(merged).toBeDefined();
		expect(forceAdaptiveThinking(merged!)).toBe(true);
	});

	it("does not set compat.forceAdaptiveThinking for a non-adaptive model merged live", async () => {
		const { mergeModelsDevEntries } = await import("../src/models/models-snapshot.js");
		const registry = new Map<string, Map<string, Model<Api>>>();

		mergeModelsDevEntries(registry, [{ id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" }]);

		const merged = registry.get("anthropic")?.get("claude-sonnet-4-5");
		expect(merged).toBeDefined();
		expect(forceAdaptiveThinking(merged!)).toBeUndefined();
	});
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic thinking disable E2E", { tags: ["real-llm"] }, () => {
	it("disables thinking for Claude reasoning models", { retry: 2, timeout: 30000 }, async () => {
		const result = await runWithoutReasoning(getModel("anthropic", "claude-sonnet-4-5")!);

		expect(result.thinkingEventCount).toBe(0);
		expect(result.thinkingCharCount).toBe(0);
		expect(result.contentTypes).not.toContain("thinking");
		expect(countPongs(result.text)).toBeGreaterThanOrEqual(35);
	});
});
