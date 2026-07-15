/**
 * createHeadlessSession — production-like headless Alef for real-LLM tests.
 *
 * Same assembly as createAgent plus env model resolution (resolveEnvModel).
 * Does not import @dpopsuev/alef-eval.
 *
 * Usage:
 *   const session = await createHeadlessSession([adapter], { systemPrompt, timeoutMs });
 *   const { reply, events } = await session.send("…");
 *   await session.dispose();
 */

import { createAgent } from "@dpopsuev/alef-agent/create-agent";
import { hasCredentials, resolveEnvModel } from "@dpopsuev/alef-agent/model";
import { getEnvApiKey } from "@dpopsuev/alef-ai/env";
import type { Api, Model } from "@dpopsuev/alef-ai/types";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { NotificationMessage } from "@dpopsuev/alef-kernel/bus";
import type { DesiredStateSpec } from "@dpopsuev/alef-kernel/reconciliation";

/** True when the ALEF_TEST_LLM env var is set. Gates all real-LLM tests. */
export const HAVE_REAL_LLM = process.env.ALEF_TEST_LLM === "1";

/** True when ALEF_TEST_LLM=1 and provider credentials are present. */
export function haveHeadlessLlm(): boolean {
	return HAVE_REAL_LLM && hasCredentials();
}

/** Result of one headless send. */
export interface HeadlessResult {
	reply: string;
	events: NotificationMessage[];
}

/** Production-like headless session. */
export interface HeadlessSession {
	readonly model: Model<Api>;
	send(text: string): Promise<HeadlessResult>;
	dispose(): Promise<void>;
}

/** Options for createHeadlessSession. */
export interface HeadlessSessionOptions {
	/** Working directory for directives / environment block. Default process.cwd(). */
	cwd?: string;
	/**
	 * Model id (`claude-sonnet-4-5`, `anthropic/…`, or `ALEF_MODEL` / `ALEF_E2E_MODEL`).
	 * When omitted, uses resolveEnvModel() from current env credentials.
	 */
	modelId?: string;
	/** Per-turn controller timeout in ms. Default 60_000. */
	timeoutMs?: number;
	/**
	 * When set: lean system prompt via createAgent (no coding-agent persona).
	 * When omitted: full createAgent default directives.
	 */
	systemPrompt?: string;
	/** Desired state for ErrorTensor / ProgressTelemetry (published as plan.dss). */
	desiredState?: DesiredStateSpec;
}

/**
 * Create a production-like headless session mounting the given adapters.
 * Resolves the model from the current process environment.
 */
export async function createHeadlessSession(
	adapters: Adapter[],
	opts: HeadlessSessionOptions = {},
): Promise<HeadlessSession> {
	const cwd = opts.cwd ?? process.cwd();
	// eslint-disable-next-line no-magic-numbers
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const model = resolveEnvModel({ modelId: opts.modelId, onMissing: "throw" });

	const events: NotificationMessage[] = [];
	const { agent, controller } = await createAgent({
		cwd,
		model,
		adapters,
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
		...(opts.desiredState !== undefined ? { desiredState: opts.desiredState } : {}),
		getApiKey: (provider) => getEnvApiKey(provider) ?? undefined,
		llm: { timeoutMs },
	});

	agent.observe({
		onCommand() {},
		onEvent() {},
		onNotification(event) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage narrowed in onNotification
			events.push(event as NotificationMessage);
		},
	});

	return {
		model,
		async send(text: string): Promise<HeadlessResult> {
			events.length = 0;
			await agent.ready();
			const reply = await controller.send(text, "human", timeoutMs);
			return { reply, events: [...events] };
		},
		async dispose() {
			controller.dispose();
			await agent.dispose();
		},
	};
}
