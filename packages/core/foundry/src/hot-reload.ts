import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import type { ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { defineManagedService } from "./managed-service.js";

const execAsync = promisify(exec);

// eslint-disable-next-line no-magic-numbers -- 10MB buffer for large monorepo builds
const BUILD_MAX_BUFFER = 10 * 1024 * 1024;

/** Callback handle exposed when the hot-reload service starts. */
export interface HotReloadRebuildHandle {
	/** Build then swap the session service in-process. */
	requestRebuild(): Promise<void>;
}

/** Configuration for the Foundry hot-reload service descriptor. */
export interface HotReloadOpts {
	buildCommand: string;
	swap: (serviceName: string, opts: { cwd: string; logger?: AdapterLogger }) => Promise<void>;
	sessionServiceName: string;
	cwd: string;
	/** Called when the rebuild handle is ready (and again cleared via onStopped). */
	onReady?: (handle: HotReloadRebuildHandle) => void;
	onStopped?: () => void;
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

			const handle: HotReloadRebuildHandle = {
				requestRebuild: async () => {
					if (rebuildInFlight) return rebuildInFlight;

					rebuildInFlight = (async () => {
						logger?.info({}, "Hot reload: build starting");

						try {
							const buildStart = Date.now();
						logger?.info({ command: opts.buildCommand }, "Hot reload: exec starting");
						const { stderr } = await execAsync(opts.buildCommand, {
								cwd: opts.cwd,
								maxBuffer: BUILD_MAX_BUFFER,
								timeout: 120_000,
							});
						logger?.info({ elapsed: Date.now() - buildStart }, "Hot reload: exec completed");

							if (stderr) {
								logger?.warn({ stderr }, "Build warnings");
							}

							logger?.info({}, "Hot reload: build passed, swapping session");

							await opts.swap(opts.sessionServiceName, {
								cwd: opts.cwd,
								logger,
							});

							logger?.info({}, "Hot reload: complete");
						} catch (err) {
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
