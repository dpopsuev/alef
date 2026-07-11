import type { AgentDefinitionSurfaceInput } from "@dpopsuev/alef-blueprint/types";
import type { Agent } from "@dpopsuev/alef-engine/agent";
import { createRouterAdapter, HTTP, type RouterAdapter } from "@dpopsuev/alef-engine/http";
import type { AgentEvent, Session } from "@dpopsuev/alef-session/contracts";
import type { Args } from "../boot/args.js";
import { metricsHandler, setupMetrics } from "../boot/metrics.js";

/** Running HTTP router with its resolved port for SSE and REST endpoints. */
export interface HttpSurface {
	port: number;
	router: RouterAdapter;
}

const MAX_HISTORY_EVENTS = 500;

/** Wire up the HTTP/SSE router with agent event forwarding, metrics, and state endpoints. */
async function createRouter(
	servePort: number,
	blueprintSurfaces: AgentDefinitionSurfaceInput[],
	session: Session,
	args: Args,
	agent: Agent,
): Promise<HttpSurface> {
	const allowedEvents = blueprintSurfaces.flatMap((surface) => surface.events ?? []);
	const history: Record<string, unknown>[] = [];

	const router = createRouterAdapter({
		port: servePort,
		host: args.host,
		allowedEvents,
		triggerEvent: "llm.input",
		onMessage: (content) => session.receive?.(content),
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

	router.addRoute("GET", "/metrics", (_req, res) => {
		metricsHandler()
			.then((body) => router.sendText(res, HTTP.OK, body, "text/plain; version=0.0.4; charset=utf-8"))
			.catch((err: unknown) => router.sendJson(res, HTTP.INTERNAL, { error: String(err) }));
	});

	agent.load(router);
	setupMetrics(agent.asBus());

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

	return { port: addr.port, router };
}

/** Create and start the HTTP/SSE router surface if --serve or --daemon is active. */
export async function setupHttpSurface(
	args: Args,
	agent: Agent,
	session: Session,
	blueprintSurfaces: AgentDefinitionSurfaceInput[],
): Promise<HttpSurface | undefined> {
	const servePort = args.daemon ? 0 : args.serve;
	if (servePort === undefined) return undefined;

	return createRouter(servePort, blueprintSurfaces, session, args, agent);
}
