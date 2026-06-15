/**
 * createE2eSession — lightweight real-LLM harness for organ E2E tests.
 *
 * Each organ owns its own E2E test. This helper removes the boilerplate of
 * wiring a real organ-llm + DialogOrgan + Agent so tests can focus on the
 * forcing-function assertion: "LLM used the tool and got the right answer."
 *
 * Usage:
 *   import { createE2eSession, HAVE_REAL_LLM } from "@dpopsuev/alef-testkit";
 *
 *   describe.skipIf(!HAVE_REAL_LLM)("organ-fs real LLM E2E", () => {
 *     it("LLM reads unguessable file", async () => {
 *       const session = createE2eSession([createFsOrgan({ cwd })]);
 *       const { reply, events } = await session.send("Read secret.txt and tell me the UUID");
 *       expect(reply).toContain(uuid);
 *       session.dispose();
 *     });
 *   });
 */

import type { Organ, SignalEvent } from "@dpopsuev/alef-kernel";
import { getEnvApiKey, getModel } from "@dpopsuev/alef-llm";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createAgentLoop } from "@dpopsuev/alef-organ-llm";
import { Agent } from "@dpopsuev/alef-runtime";

/** True when at least one real LLM provider is configured via env vars. */
export const HAVE_REAL_LLM =
	Boolean(process.env.ANTHROPIC_API_KEY) ||
	Boolean(process.env.ANTHROPIC_VERTEX_PROJECT_ID) ||
	Boolean(process.env.GOOGLE_CLOUD_PROJECT);

export interface E2eResult {
	reply: string;
	events: SignalEvent[];
}

export interface E2eSession {
	send(text: string): Promise<E2eResult>;
	dispose(): void;
}

export interface E2eSessionOptions {
	/** Model ID. Defaults to claude-haiku-4-5 (cheapest, fast enough for forcing-function tests). */
	modelId?: string;
	/** Turn timeout in ms. Default 60_000. */
	timeoutMs?: number;
}

/**
 * Create a real-LLM session mounting the given organs.
 * Resolves the model from env vars (Anthropic direct or Vertex).
 */
export function createE2eSession(organs: Organ[], opts: E2eSessionOptions = {}): E2eSession {
	const modelId = opts.modelId ?? process.env.ALEF_E2E_MODEL ?? "claude-haiku-4-5";
	const timeoutMs = opts.timeoutMs ?? 60_000;

	// Resolve provider and API key from environment.
	const provider = process.env.ANTHROPIC_VERTEX_PROJECT_ID ? "anthropic-vertex" : "anthropic";
	const apiKey = getEnvApiKey(provider) ?? "";
	const model =
		getModel(provider as "anthropic", modelId as never) ?? getModel("anthropic", "claude-haiku-4-5" as never);

	const agent = new Agent();
	let reply = "";
	const events: SignalEvent[] = [];

	const dialog = new DialogOrgan({
		sink: (t) => {
			if (t) reply = t;
		},
	});
	const llm = createAgentLoop({
		model,
		getApiKey: () => apiKey,
		timeoutMs,
	});

	for (const organ of organs) agent.load(organ);
	agent.load(dialog).load(llm);
	agent.observe({
		onMotorEvent() {},
		onSenseEvent() {},
		onSignalEvent(event) {
			events.push(event as SignalEvent);
		},
	});

	return {
		async send(text: string): Promise<E2eResult> {
			reply = "";
			events.length = 0;
			await agent.ready();
			await dialog.send(text, "human", timeoutMs);
			return { reply, events: [...events] };
		},
		dispose() {
			agent.dispose();
		},
	};
}
