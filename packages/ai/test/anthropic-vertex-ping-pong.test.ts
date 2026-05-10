import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { describe, expect, it } from "vitest";

/**
 * Opt-in E2E: Claude on Vertex via `@anthropic-ai/vertex-sdk` (ping → pong).
 *
 * Set `ANTHROPIC_VERTEX_PING_PONG=1`, then configure Google auth (for example
 * `gcloud auth application-default login` or `GOOGLE_APPLICATION_CREDENTIALS`).
 *
 * Required:
 * - `ANTHROPIC_VERTEX_PROJECT_ID`
 * - `CLOUD_ML_REGION` or `GOOGLE_CLOUD_LOCATION` (often `global` for Claude on Vertex)
 *
 * Optional:
 * - `ANTHROPIC_VERTEX_MODEL` — Vertex publisher model ID (default `claude-sonnet-4@20250514`)
 */
function resolveAnthropicVertexPingPongConfig(): { projectId: string; region: string; model: string } | undefined {
	if (process.env.ANTHROPIC_VERTEX_PING_PONG !== "1") {
		return undefined;
	}
	const projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID;
	const region = process.env.CLOUD_ML_REGION || process.env.GOOGLE_CLOUD_LOCATION;
	if (!projectId || !region) {
		return undefined;
	}
	const model = process.env.ANTHROPIC_VERTEX_MODEL ?? "claude-sonnet-4@20250514";
	return { projectId, region, model };
}

const vertexPingPongConfig = resolveAnthropicVertexPingPongConfig();

describe.skipIf(!vertexPingPongConfig)("Anthropic Vertex SDK ping pong", () => {
	it("replies pong to a constrained ping prompt", { retry: 2, timeout: 60_000 }, async () => {
		const cfg = vertexPingPongConfig!;
		const client = new AnthropicVertex({
			projectId: cfg.projectId,
			region: cfg.region,
		});

		const result = await client.messages.create({
			model: cfg.model,
			max_tokens: 32,
			messages: [
				{
					role: "user",
					content:
						'You must reply with exactly the lowercase word "pong" and nothing else — no punctuation, no quotes, no explanation.',
				},
			],
		});

		let text = "";
		for (const block of result.content) {
			if (block.type === "text") {
				text += block.text;
			}
		}
		text = text.trim().toLowerCase();

		expect(text).toBe("pong");
	});
});
