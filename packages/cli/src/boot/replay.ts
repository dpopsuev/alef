import { Agent } from "@dpopsuev/alef-engine/agent";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import { createReplayAdapters } from "@dpopsuev/alef-session/replay";
import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import { extractTrace } from "@dpopsuev/alef-session/tracing";

const REPLAY_TURN_TIMEOUT_MS = 30_000;
const REPLY_PREVIEW_MAX_CHARS = 200;
const TOOL_ARGS_PREVIEW_MAX_CHARS = 80;
const PROMPT_PREVIEW_MAX_CHARS = 60;

/** Replay a recorded session turn-by-turn with zero tokens, printing tool calls and usage. */
export async function runReplay(cwd: string, sessionIdOrLast: string): Promise<void> {
	const store =
		sessionIdOrLast === "last"
			? await JsonlSessionStore.resumeLatest(cwd)
			: await JsonlSessionStore.resume(cwd, sessionIdOrLast);

	if (!store) {
		console.error("No sessions found for current directory.");
		process.exit(1);
	}

	const records = await store.events();
	const trace = extractTrace(records);
	if (trace.length === 0) {
		console.error("Session has no turns to replay.");
		process.exit(1);
	}

	console.log(`Replaying session ${store.id} (${trace.length} turns, 0 tokens)`);
	console.log();

	const { reasoner, tools } = createReplayAdapters(trace);
	const agent = new Agent();
	agent.load(reasoner);
	agent.load(tools);

	const controller = new AgentController(agent, {
		onReply: (text) => {
			if (text) {
				const preview =
					text.length > REPLY_PREVIEW_MAX_CHARS ? `${text.slice(0, REPLY_PREVIEW_MAX_CHARS)}...` : text;
				console.log(`  [reply] ${preview}`);
			}
		},
	});

	agent.observe({
		onCommand() {},
		onEvent() {},
		onNotification(event) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage concrete subtypes carry payload
			const p = (event as { payload?: Record<string, unknown> }).payload ?? {};
			if (event.type === "llm.tool-start") {
				console.log(
					`  [tool] ${String(p.name)}(${JSON.stringify(p.args ?? {}).slice(0, TOOL_ARGS_PREVIEW_MAX_CHARS)})`,
				);
			}
			if (event.type === "llm.token-usage") {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- bus payload shape guaranteed by llm adapter
				const u = p.usage as { input: number; output: number } | undefined;
				console.log(`  [usage] ${u?.input ?? 0} in / ${u?.output ?? 0} out`);
			}
		},
	});

	for (let i = 0; i < trace.length; i++) {
		const step = trace[i];
		const preview =
			step.userMessage.length > PROMPT_PREVIEW_MAX_CHARS
				? `${step.userMessage.slice(0, PROMPT_PREVIEW_MAX_CHARS)}...`
				: step.userMessage;
		console.log(`Turn ${i}: "${preview}"`);
		await controller.send(step.userMessage, "human", REPLAY_TURN_TIMEOUT_MS);
	}

	console.log();
	console.log("Replay complete.");
	void agent.dispose();
}
