import type { Args } from "./args.js";
import { trace } from "./debug-trace.js";
import { runInteractive } from "./interactive.js";
import { shutdownOTel } from "./otel.js";
import { runPrintMode } from "./print-mode.js";
import type { Session } from "./session.js";

import { runTuiMode } from "./tui-mode.js";

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
	reloadOrgan: (name: string, path: string) => Promise<void>;
	getDirectiveAdapter: () => unknown;

	session: Session;
}

export async function runAgent(opts: RunAgentOptions): Promise<void> {
	const { args } = opts;

	process.once("SIGINT", () => {
		process.exit(0);
	});

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	process.once("SIGTERM", async () => {
		process.stderr.write("\n[signal] SIGTERM — shutting down cleanly\n");
		try {
			opts.session.dispose();
			await shutdownOTel();
		} finally {
			process.exit(0);
		}
	});

	const useTui = !args.print && !args.json && !args.noTui && process.stdin.isTTY;

	try {
		if (args.print) {
			await runPrintMode(args.prompt, opts.session);
		} else if (useTui) {
			const originalStderrWrite = process.stderr.write.bind(process.stderr);
			process.stderr.write = (
				_chunk: string | Uint8Array,
				encOrCb?: BufferEncoding | ((err?: Error | null) => void),
				cb?: (err?: Error | null) => void,
			): boolean => {
				const callback = typeof encOrCb === "function" ? encOrCb : cb;
				callback?.();
				return true;
			};
			try {
				await runTuiMode(opts.session, {
					cwd: args.cwd,
					modelId: opts.resolvedModelDisplay,
					sessionId: opts.sessionId,
					contextWindow: opts.contextWindow,
					getModel: opts.getModel,
					setModel: opts.setModel,
					getThinking: opts.getThinking,
					setThinking: opts.setThinking,
				});
			} finally {
				process.stderr.write = originalStderrWrite;
			}
		} else if (args.serve !== undefined && !process.stdin.isTTY) {
			await new Promise<void>(() => {});
		} else {
			await runInteractive(opts.session, {
				cwd: args.cwd,
				modelId: opts.resolvedModelDisplay,
				sessionId: opts.sessionId,
			});
		}
	} finally {
		trace("shutdownOTel:start");
		await Promise.race([shutdownOTel(), new Promise<void>((resolve) => setTimeout(resolve, 2000).unref())]);
		trace("shutdownOTel:done");
	}
}
