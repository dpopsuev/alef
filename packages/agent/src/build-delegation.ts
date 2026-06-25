import type { AgentDefinitionSurfaceInput } from "@dpopsuev/alef-blueprint";
import type { Api, Model } from "@dpopsuev/alef-llm";
import type { Agent } from "@dpopsuev/alef-runtime";
import { buildDelegationStack } from "@dpopsuev/alef-runtime";
import { createCompactionStage, createSessionContextStage } from "@dpopsuev/alef-session";
import { createAgentAdapter, strategyRegistry } from "@dpopsuev/alef-tool-agent";
import { createFactoryAdapter } from "@dpopsuev/alef-tool-factory";
import { createRouterAdapter } from "@dpopsuev/alef-tool-gateway";
import type { Args } from "./args.js";
import type { AgentEvent, Session } from "./session.js";
import { buildSubagentFactory } from "./subagent-factory.js";

const MAX_HISTORY_EVENTS = 500;

async function createRouter(
	servePort: number,
	blueprintSurfaces: AgentDefinitionSurfaceInput[],
	session: Session,
	args: Args,
	agent: Agent,
): Promise<number> {
	const sseSurface = blueprintSurfaces.filter((surface) => surface.type === "sse");
	const allowedEvents = sseSurface.flatMap((surface) => surface.events ?? []);
	const history: Record<string, unknown>[] = [];

	const router = createRouterAdapter({
		port: servePort,
		allowedEvents,
		triggerEvent: "llm.input",
		onMessage: (text) => session.receive?.(text),
		getState: () => ({
			modelId: session.getModel(),
			thinking: session.getThinking(),
			contextWindow: session.state.contextWindow,
			sessionId: session.state.id,
		}),
		onSetModel: (id) => {
			session.setModel(id);
			router.notifyStateChange({
				modelId: session.getModel(),
				thinking: session.getThinking(),
				contextWindow: session.state.contextWindow,
			});
		},
		onSetThinking: (level) => {
			session.setThinking(level);
			router.notifyStateChange({
				modelId: session.getModel(),
				thinking: session.getThinking(),
				contextWindow: session.state.contextWindow,
			});
		},
		onCancel: () => {
			agent.publishEvent({
				type: "budget.cancel",
				payload: { reason: "cancelled by attached client" },
				correlationId: "remote-cancel",
				isError: false,
			});
		},
		onReloadAdapter: async (name, path) => {
			await session.reloadAdapter?.(name, path);
		},
		getHistory: () => history,
	});

	agent.load(router);
	await router.ready();
	const addr = router.address() ?? { host: "127.0.0.1", port: 0 };
	console.error(`[alef] router listening on http://${addr.host}:${addr.port}`);

	if (args.daemon) {
		session.subscribe((event: AgentEvent) => {
			router.notifyAgent(event);
			history.push(event);
			if (history.length > MAX_HISTORY_EVENTS) history.shift();
		});
	}

	return addr.port;
}

export async function setupHttpSurface(
	args: Args,
	agent: Agent,
	session: Session,
	blueprintSurfaces: AgentDefinitionSurfaceInput[],
): Promise<number | undefined> {
	const servePort = args.daemon ? 0 : args.serve;
	if (servePort === undefined) return undefined;

	return createRouter(servePort, blueprintSurfaces, session, args, agent);
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
		adapters: { createAgentAdapter, strategyRegistry, createCompactionStage, createSessionContextStage },
	});

	for (const adapter of adapters) agent.load(adapter);

	const servePort = args.daemon ? 0 : args.serve;
	if (servePort !== undefined) {
		await createRouter(servePort, blueprintSurfaces, session, args, agent);
	}
}
