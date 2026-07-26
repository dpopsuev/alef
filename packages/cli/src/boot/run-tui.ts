import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { Args } from "./args.js";
import type { AssembledSession } from "./assemble-session.js";
import { ServeViewMode, selectViewMode } from "./views.js";

/** Live handle for a running view mode. Not an independent restart boundary -- callers own restart-in-place directly. */
export interface TuiHandle {
	/** Resolves when the view mode's own run loop exits. */
	readonly done: Promise<void>;
	stop(): void;
}

/** Options for running the selected view mode directly against an assembled session. */
export interface RunTuiOptions {
	args: Args;
	store?: SessionStore;
	session: AssembledSession;
}

/** Run the selected view mode (interactive TUI, serve, print, or json) directly -- no service-registry indirection. */
export function runTui(opts: RunTuiOptions): TuiHandle {
	const interactiveOpts = {
		cwd: opts.args.cwd,
		modelId: opts.session.resolvedModelDisplay,
		sessionId: opts.session.session.state.id,
		contextWindow: opts.session.session.state.contextWindow,
		getModel: () => opts.session.session.getModel(),
		setModel: (id: string) => opts.session.session.setModel(id),
		getThinking: () => opts.session.session.getThinking(),
		setThinking: (level: string) => opts.session.session.setThinking(level),
		humanAddress: opts.session.humanAddress,
		agentAddress: opts.session.agentAddress,
		blueprintName: opts.session.blueprintPath ?? opts.session.blueprintName,
		discussion: opts.session.session.state.discussion?.active,
	};

	const viewer = selectViewMode(opts.args, interactiveOpts, opts.store);
	let doneResolve: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		doneResolve = resolve;
	});

	void viewer.run(opts.session.session).finally(() => {
		doneResolve();
	});

	return {
		done,
		stop() {
			if (viewer instanceof ServeViewMode) viewer.stop();
			doneResolve();
		},
	};
}
