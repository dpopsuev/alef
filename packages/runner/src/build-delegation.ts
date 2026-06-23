import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFactoryAdapter } from "@dpopsuev/alef-adapter-factory";
import type { AgentDefinitionSurfaceInput } from "@dpopsuev/alef-agent-blueprint";
import { buildDelegationStack } from "@dpopsuev/alef-agent-blueprint";
import { createRouterAdapter } from "@dpopsuev/alef-gateway";
import type { Api, Model } from "@dpopsuev/alef-llm";
import type { Agent } from "@dpopsuev/alef-runtime";
import type { Args } from "./args.js";
import type { AgentEvent, Session } from "./session.js";
import { buildSubagentFactory } from "./subagent-factory.js";

async function createRouter(
	servePort: number,
	blueprintSurfaces: AgentDefinitionSurfaceInput[],
	session: Session,
	args: Args,
	agent: Agent,
): Promise<void> {
	const sseSurface = blueprintSurfaces.filter((surface) => surface.type === "sse");
	const allowedEvents = sseSurface.flatMap((surface) => surface.events ?? []);
	const router = createRouterAdapter({
		port: servePort,
		allowedEvents,
		triggerEvent: "llm.input",
		onMessage: (text) => session.receive?.(text),
	});
	agent.load(router);
	await router.ready();
	const addr = router.address() ?? { host: "127.0.0.1", port: 0 };
	console.error(`[alef] router listening on http://${addr.host}:${addr.port}`);

	if (args.daemon) {
		session.subscribe((event: AgentEvent) => {
			router.notifyAgent(event);
		});
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

export async function setupHttpSurface(
	args: Args,
	agent: Agent,
	session: Session,
	blueprintSurfaces: AgentDefinitionSurfaceInput[],
): Promise<void> {
	const servePort = args.daemon ? 0 : args.serve;
	if (servePort === undefined) return;

	await createRouter(servePort, blueprintSurfaces, session, args, agent);
}

export async function buildDelegation(
	args: Args,
	model: Model<Api>,
	agent: Agent,
	session: Session,
	blueprintSurfaces: AgentDefinitionSurfaceInput[],
): Promise<void> {
	const factory = buildSubagentFactory({ model, trackConcurrentOps: true, forwardToolChunks: true });
	const factoryAdapter = createFactoryAdapter({ cwd: args.cwd });

	const { adapters } = await buildDelegationStack({
		cwd: args.cwd,
		factory,
		contextWindow: model.contextWindow,
		extraAdapters: [factoryAdapter],
	});

	for (const adapter of adapters) agent.load(adapter);

	const servePort = args.daemon ? 0 : args.serve;
	if (servePort !== undefined) {
		await createRouter(servePort, blueprintSurfaces, session, args, agent);
	}
}
