import type { ActorRouteTable } from "@dpopsuev/alef-agent/identity/routes";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { Args } from "../boot/args.js";
import { shutdownOTel } from "../boot/otel.js";
import { selectViewMode } from "../boot/views.js";

export interface RunAgentOptions {
	args: Args;
	resolvedModelDisplay: string;
	sessionId: string;
	contextWindow: number;
	getModel: () => string;
	setModel: (id: string) => void;
	getThinking: () => string;
	setThinking: (level: string) => void;
	setLLMAbortController: (ctrl: AbortController | undefined) => void;
	reloadAdapter: (name: string, path: string) => Promise<void>;
	getDirectiveAdapter: () => unknown;

	session: Session;
	/** Session store — passed to TuiViewMode for eager history load on resume. */
	store?: SessionStore;
	/** Human's @ address (e.g. "@dpopsuev"). Passed to TUI for pill label. */
	humanAddress?: string;
	/** Agent's @ address (e.g. "@crimson"). Passed to TUI for pill label. */
	agentAddress?: string;
	/** Route table for @-mention routing in TUI. */
	actorRoutes?: ActorRouteTable;
}

export async function runAgent(opts: RunAgentOptions): Promise<void> {
	const { args } = opts;

	const interactiveOpts = {
		cwd: args.cwd,
		modelId: opts.resolvedModelDisplay,
		sessionId: opts.sessionId,
		contextWindow: opts.contextWindow,
		getModel: opts.getModel,
		setModel: opts.setModel,
		getThinking: opts.getThinking,
		setThinking: opts.setThinking,
		humanAddress: opts.humanAddress ?? "@you",
		agentAddress: opts.agentAddress ?? "@alef",
		actorRoutes: opts.actorRoutes,
	};

	// Daemon/serve with no TTY — keep the process alive but let the router handle I/O.
	if (args.serve !== undefined && !process.stdin.isTTY && !args.print) {
		try {
			await new Promise<void>(() => {});
		} finally {
			traceEvent("shutdownOTel:start");
			await Promise.race([shutdownOTel(), new Promise<void>((resolve) => setTimeout(resolve, 2000).unref())]);
			traceEvent("shutdownOTel:done");
		}
		return;
	}

	const viewer = selectViewMode(args, interactiveOpts, opts.store);

	// TUI suppresses stderr to avoid corrupting the terminal layout.
	const isTui = !args.print && !args.json && !args.noTui && process.stdin.isTTY;
	const originalStderrWrite = isTui ? process.stderr.write.bind(process.stderr) : null;
	if (isTui) {
		process.stderr.write = (
			_chunk: string | Uint8Array,
			encOrCb?: BufferEncoding | ((err?: Error | null) => void),
			cb?: (err?: Error | null) => void,
		): boolean => {
			const callback = typeof encOrCb === "function" ? encOrCb : cb;
			callback?.();
			return true;
		};
	}

	try {
		await viewer.run(opts.session);
	} finally {
		if (originalStderrWrite) process.stderr.write = originalStderrWrite;
		traceEvent("shutdownOTel:start");
		await Promise.race([shutdownOTel(), new Promise<void>((resolve) => setTimeout(resolve, 2000).unref())]);
		traceEvent("shutdownOTel:done");
	}
}
