import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { Args } from "./args.js";
import type { Session } from "./session.js";
import { selectViewMode } from "./view-mode.js";

export interface TuiServiceOptions {
	args: Args;
	resolvedModelDisplay: string;
	sessionId: string;
	contextWindow: number;
	getModel: () => string;
	setModel: (id: string) => void;
	getThinking: () => string;
	setThinking: (level: string) => void;
	humanAddress?: string;
	agentAddress?: string;
	session: Session;
	store?: SessionStore;
}

export function createTuiServiceDescriptor(opts: TuiServiceOptions): ServiceDescriptor {
	return {
		name: "tui",
		restart: "permanent",
		shareable: true,
		dependsOn: ["agent"],

		create(_createOpts: ServiceCreateOpts): Promise<ManagedService> {
			const interactiveOpts = {
				cwd: opts.args.cwd,
				modelId: opts.resolvedModelDisplay,
				sessionId: opts.sessionId,
				contextWindow: opts.contextWindow,
				getModel: opts.getModel,
				setModel: opts.setModel,
				getThinking: opts.getThinking,
				setThinking: opts.setThinking,
				humanAddress: opts.humanAddress ?? "@you",
				agentAddress: opts.agentAddress ?? "@alef",
			};

			const viewer = selectViewMode(opts.args, interactiveOpts, opts.store);
			let running = false;

			return Promise.resolve({
				name: "tui",
				restart: "permanent" as const,
				adapters: [],
				tools: [],
				start() {
					running = true;
					void viewer.run(opts.session).finally(() => {
						running = false;
					});
					return Promise.resolve();
				},
				stop() {
					running = false;
					return Promise.resolve();
				},
				health: () => Promise.resolve(running),
			});
		},
	};
}
