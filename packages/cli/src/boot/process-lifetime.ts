/** Default idle timeout for ephemeral --serve (non-daemon) processes. */
export const SERVE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Options controlling how long the process stays alive after boot. */
export interface ProcessLifetimeOpts {
	/** Daemon mode: wait forever (signals call process.exit elsewhere). */
	daemon: boolean;
	/** HTTP serve port was requested. */
	serve: boolean;
	/** Viewer completion promise when not serving. */
	done?: Promise<void>;
	/** Idle timeout for ephemeral serve; defaults to SERVE_IDLE_TIMEOUT_MS. */
	idleTimeoutMs?: number;
}

/**
 * Block until the process should exit:
 * - daemon + serve → never resolves (caller exits via signal handlers)
 * - ephemeral serve → idle timeout
 * - otherwise → await viewer `done`
 */
export async function awaitProcessLifetime(opts: ProcessLifetimeOpts): Promise<void> {
	if (opts.serve) {
		await new Promise<void>((resolve) => {
			if (opts.daemon) return;
			const timer = setTimeout(resolve, opts.idleTimeoutMs ?? SERVE_IDLE_TIMEOUT_MS);
			timer.unref();
		});
		return;
	}
	if (opts.done) await opts.done;
}
