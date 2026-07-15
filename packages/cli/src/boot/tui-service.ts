import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { Args } from "./args.js";
import type { SessionService } from "./session-service.js";
import { ServeViewMode, selectViewMode } from "./views.js";

/** Managed service wrapping the TUI view mode with a completion promise. */
export interface TuiService extends ManagedService {
	readonly done: Promise<void>;
}

/** Options for creating the TUI supervisor service. */
export interface TuiServiceOptions {
	args: Args;
	store?: SessionStore;
}

/** Build a ServiceDescriptor that runs the selected view mode as a managed service. */
export function createTuiServiceDescriptor(opts: TuiServiceOptions): ServiceDescriptor {
	return {
		name: "tui",
		restart: "permanent",
		shareable: true,
		dependsOn: ["session"],

		create(createOpts: ServiceCreateOpts): Promise<TuiService> {
			const raw = createOpts.supervisor?.get("session");
			if (!raw || !("session" in raw)) throw new Error("Session service not found — TUI depends on session");
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by 'session' in check
			const sessionSvc = raw as SessionService;

			const interactiveOpts = {
				cwd: opts.args.cwd,
				modelId: sessionSvc.resolvedModelDisplay,
				sessionId: sessionSvc.session.state.id,
				contextWindow: sessionSvc.session.state.contextWindow,
				getModel: () => sessionSvc.session.getModel(),
				setModel: (id: string) => sessionSvc.session.setModel(id),
				getThinking: () => sessionSvc.session.getThinking(),
				setThinking: (level: string) => sessionSvc.session.setThinking(level),
				humanAddress: sessionSvc.humanAddress,
				agentAddress: sessionSvc.agentAddress,
				blueprintName: sessionSvc.blueprintName,
			};

			const viewer = selectViewMode(opts.args, interactiveOpts, opts.store);
			let running = false;
			let doneResolve: () => void = () => {};
			const done = new Promise<void>((resolve) => {
				doneResolve = resolve;
			});

			return Promise.resolve({
				name: "tui",
				restart: "permanent" as const,
				adapters: [],
				tools: [],
				done,
				start() {
					running = true;
					void viewer.run(sessionSvc.session).finally(() => {
						running = false;
						doneResolve();
					});
					return Promise.resolve();
				},
				stop() {
					running = false;
					if (viewer instanceof ServeViewMode) viewer.stop();
					doneResolve();
					return Promise.resolve();
				},
				health: () => Promise.resolve(running),
			});
		},
	};
}
