import { exec, type ExecOptions } from "node:child_process";
import type { AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import type { ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { defineManagedService } from "./managed-service.js";

/** Promisified exec that closes stdin on the child to prevent TUI stdin conflicts. */
function execAsync(
	command: string,
	options: ExecOptions & { maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = exec(command, options, (err, stdout, stderr) => {
			if (err) reject(err);
			else resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
		child.stdin?.end();
	});
}

// eslint-disable-next-line no-magic-numbers -- 10MB buffer for large monorepo builds
const BUILD_MAX_BUFFER = 10 * 1024 * 1024;

/** Callback handle exposed when the hot-reload service starts. */
export interface HotReloadRebuildHandle {
	/** Build then swap the session service in-process. */
	requestRebuild(): Promise<void>;
}

/** Trace callback for hot-reload lifecycle events. */
export type HotReloadTrace = (phase: string, detail?: Record<string, unknown>) => void;

/** Configuration for the Foundry hot-reload service descriptor. */
export interface HotReloadOpts {
	buildCommand: string;
	swap: (serviceName: string, opts: { cwd: string; logger?: AdapterLogger }) => Promise<void>;
	sessionServiceName: string;
	cwd: string;
	/** Called when the rebuild handle is ready (and again cleared via onStopped). */
	onReady?: (handle: HotReloadRebuildHandle) => void;
	onStopped?: () => void;
	/** Lifecycle trace sink -- each phase emits a trace event for diagnostics. */
	trace?: HotReloadTrace;
}

/** Build a `ServiceDescriptor` that exposes in-process rebuild and session swap. */
export function createHotReloadDescriptor(opts: HotReloadOpts): ServiceDescriptor {
	return defineManagedService({
		name: "hot-reload",
		restart: "permanent",
		shareable: true,
		create({ logger }: ServiceCreateOpts) {
			let active = false;
			let rebuildInFlight: Promise<void> | undefined;
			const trace = opts.trace ?? (() => {});

			const handle: HotReloadRebuildHandle = {
				requestRebuild: async () => {
					if (rebuildInFlight) return rebuildInFlight;

					rebuildInFlight = (async () => {
						const t0 = Date.now();
						trace("build:start", { command: opts.buildCommand });
						logger?.info({}, "Hot reload: build starting");

						try {
							const { stderr } = await execAsync(opts.buildCommand, {
								cwd: opts.cwd,
								maxBuffer: BUILD_MAX_BUFFER,
								timeout: 120_000,
							});
							const buildMs = Date.now() - t0;
							trace("build:done", { elapsedMs: buildMs });
							logger?.info({ elapsedMs: buildMs }, "Hot reload: build completed");

							if (stderr) {
								logger?.warn({ stderr }, "Build warnings");
							}

							trace("swap:start");
							const swapStart = Date.now();
							await opts.swap(opts.sessionServiceName, {
								cwd: opts.cwd,
								logger,
							});
							const swapMs = Date.now() - swapStart;
							trace("swap:done", { elapsedMs: swapMs });
							logger?.info({ elapsedMs: swapMs }, "Hot reload: swap completed");

							trace("complete", { totalMs: Date.now() - t0 });
							logger?.info({}, "Hot reload: complete");
						} catch (err) {
							trace("error", { error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - t0 });
							logger?.error({ err }, "Hot reload failed");
							throw err;
						} finally {
							rebuildInFlight = undefined;
						}
					})();

					return rebuildInFlight;
				},
			};

			return {
				start() {
					active = true;
					opts.onReady?.(handle);
					logger?.info({}, "Hot reload service ready");
					return Promise.resolve();
				},
				stop() {
					opts.onStopped?.();
					active = false;
					return Promise.resolve();
				},
				health() {
					return Promise.resolve(active);
				},
			};
		},
	});
}
