import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDefinitionSurfaceInput } from "@dpopsuev/alef-agent-blueprint";
import type { Api, Model } from "@dpopsuev/alef-ai";
import type { Agent } from "@dpopsuev/alef-corpus";
import { createDelegateOrgan } from "@dpopsuev/alef-organ-delegate";
import { createFactoryOrgan } from "@dpopsuev/alef-organ-factory";
import { createOrchestrationOrgan } from "@dpopsuev/alef-organ-orchestration";
import { createRouterOrgan } from "@dpopsuev/alef-organ-router";
import type { Args } from "./args.js";
import { DEFAULT_COMPILED_DEFINITION, materializeBlueprint } from "./materializer.js";
import type { AgentEvent, Session } from "./session.js";
import { InProcessStrategy } from "./strategies/in-process.js";

const EXPLORE_ORGANS = [
	{ name: "fs", actions: [] as string[], toolNames: [] as string[] },
	{ name: "web", actions: [] as string[], toolNames: [] as string[] },
];

const EXPLORE_SYSTEM_PROMPT = `You are a read-only exploration agent. Your only job is to read files, search code, and fetch URLs, then report findings concisely.

Rules — follow these exactly:
- No emojis. Never. In any part of your response.
- No filler ("Great!", "Certainly!", "Let me look at..."). Start with the finding.
- No preamble. Do not narrate what you are about to do. Run the tool, return the result.
- Never write files, modify state, or execute commands that change anything.
- Return absolute file paths when listing files.
- Read files before describing them. Never claim what a file contains without reading it.
- If the caller asks you to read multiple files in parallel, do so — do not serialize reads you can batch.`;

export async function buildDelegation(
	args: Args,
	model: Model<Api>,
	agent: Agent,
	session: Session,
	blueprintSurfaces: AgentDefinitionSurfaceInput[],
): Promise<void> {
	const materialiOpts = { cwd: args.cwd };

	const [{ organs: exploreOrgans }, { organs: generalOrgans }] = await Promise.all([
		materializeBlueprint({ ...DEFAULT_COMPILED_DEFINITION, organs: [...EXPLORE_ORGANS] }, materialiOpts),
		materializeBlueprint(DEFAULT_COMPILED_DEFINITION, materialiOpts),
	]);

	const delegateOrgan = createDelegateOrgan({
		strategies: {
			explore: new InProcessStrategy(exploreOrgans, model, EXPLORE_SYSTEM_PROMPT),
			general: new InProcessStrategy(generalOrgans, model),
		},
		cwd: args.cwd,
	});

	const orchestrationOrgan = createOrchestrationOrgan({
		cwd: args.cwd,
		onChildReady: (name, strategy) => delegateOrgan.registerStrategy(name, strategy),
	});

	agent.load(delegateOrgan);
	agent.load(orchestrationOrgan);
	agent.load(createFactoryOrgan({ cwd: args.cwd }));

	const servePort = args.daemon ? 0 : args.serve;

	if (servePort !== undefined) {
		const sseSurface = blueprintSurfaces.filter((surface) => surface.type === "sse");
		const allowedEvents = sseSurface.flatMap((surface) => surface.events ?? []);
		const router = createRouterOrgan({
			port: servePort,
			allowedEvents,
			onMessage: (text) => session.receive?.(text),
		});
		agent.load(router);
		await router.ready();
		const addr = router.address() ?? { host: "127.0.0.1", port: 0 };
		console.error(`[alef] router listening on http://${addr.host}:${addr.port}`);

		if (args.daemon) {
			// Forward every AgentEvent to SSE clients so RemoteSession can drive a TUI.
			session.subscribe((event: AgentEvent) => {
				router.notifyAgent(event as unknown as Record<string, unknown>);
			});

			// Write daemon registry entry.
			const daemonDir = join(homedir(), ".alef");
			mkdirSync(daemonDir, { recursive: true });
			writeFileSync(
				join(daemonDir, "daemon.json"),
				JSON.stringify({
					port: addr.port,
					pid: process.pid,
					sessionId: session.state.id,
					cwd: args.cwd,
					startedAt: Date.now(),
				}),
			);
		}
	}
}
