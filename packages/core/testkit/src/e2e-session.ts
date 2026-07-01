/**
 * createE2eSession — lightweight real-LLM harness for adapter E2E tests.
 *
 * Each adapter owns its own E2E test. This helper removes the boilerplate of
 * wiring a real LLM adapter + AgentController + Agent so tests can focus on the
 * forcing-function assertion: "LLM used the tool and got the right answer."
 *
 * Usage:
 *   import { createE2eSession, HAVE_REAL_LLM } from "@dpopsuev/alef-testkit";
 *
 *   describe.skipIf(!HAVE_REAL_LLM)("adapter-fs real LLM E2E", () => {
 *     it("LLM reads unguessable file", async () => {
 *       const session = createE2eSession([createFsAdapter({ cwd })]);
 *       const { reply, events } = await session.send("Read secret.txt and tell me the UUID");
 *       expect(reply).toContain(uuid);
 *       session.dispose();
 *     });
 *   });
 */

import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { NotificationMessage } from "@dpopsuev/alef-kernel/bus";
import { createContextAssembler } from "@dpopsuev/alef-kernel/context-assembly";
import { getEnvApiKey } from "@dpopsuev/alef-ai/env";
import { getModel } from "@dpopsuev/alef-ai/models";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { Agent } from "@dpopsuev/alef-engine/agent";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import { createToolShellAdapter } from "@dpopsuev/alef-engine/catalog";

/** True when the ALEF_TEST_LLM env var is set. Gates all real-LLM tests. */
export const HAVE_REAL_LLM = process.env.ALEF_TEST_LLM === "1";

export interface E2eResult {
	reply: string;
	events: NotificationMessage[];
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
 * Create a real-LLM session mounting the given adapters.
 * Resolves the model from env vars (Anthropic direct or Vertex).
 */
export function createE2eSession(adapters: Adapter[], opts: E2eSessionOptions = {}): E2eSession {
	const modelId = opts.modelId ?? process.env.ALEF_E2E_MODEL ?? "claude-haiku-4-5";
	const timeoutMs = opts.timeoutMs ?? 60_000;

	const provider = process.env.ANTHROPIC_VERTEX_PROJECT_ID ? "anthropic-vertex" : "anthropic";
	const apiKey = getEnvApiKey(provider) ?? "";
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- provider string narrowed to union for getModel lookup
	const model = getModel(provider as "anthropic", modelId as never);

	const agent = new Agent();
	let reply = "";
	const events: NotificationMessage[] = [];

	const llm = createAgentLoop({
		model,
		getApiKey: () => apiKey,
		timeoutMs,
	});

	for (const adapter of adapters) agent.load(adapter);
	const toolShell = createToolShellAdapter({
		tools: adapters.flatMap((o) => o.tools),
		getTools: () => agent.tools,
	});
	const contextAssembly = createContextAssembler();
	agent.load(toolShell);
	agent.load(contextAssembly);
	agent.load(llm);
	agent.observe({
		onCommand() {},
		onEvent() {},
		onNotification(event) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage narrowed to NotificationMessage in onNotification handler
			events.push(event as NotificationMessage);
		},
	});

	const controller = new AgentController(agent, {
		onReply: (t) => {
			if (t) reply = t;
		},
	});

	return {
		async send(text: string): Promise<E2eResult> {
			reply = "";
			events.length = 0;
			await agent.ready();
			await controller.send(text, "human", timeoutMs);
			return { reply, events: [...events] };
		},
		async dispose() {
			controller.dispose();
			await agent.dispose();
		},
	};
}
