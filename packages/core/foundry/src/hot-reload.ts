import { exec, type ExecOptions } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import type { ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { defineManagedService } from "./managed-service.js";

/** Promisified exec that closes stdin on the child to prevent TUI stdin conflicts. */
function execAsync(command: string, options: ExecOptions & { maxBuffer?: number }): Promise<{ stdout: string; stderr: string }> {
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
							const trace = (msg: string): void => {
								const line = `[${new Date().toISOString()}] ${msg}\n`;
								try { appendFileSync("/tmp/alef-hot-reload.log", line); } catch {}
								logger?.info({}, msg);
							};
							trace(`Hot reload: exec starting (${opts.buildCommand})`);
							const { stderr } = await execAsync(opts.buildCommand, {
								cwd: opts.cwd,
								maxBuffer: BUILD_MAX_BUFFER,
								timeout: 120_000,
							});
							trace(`Hot reload: exec completed (${Date.now() - buildStart}ms)`);

							if (stderr) {
								logger?.warn({ stderr }, "Build warnings");
							}

							trace("Hot reload: swapping session");
							const swapStart = Date.now();
							await opts.swap(opts.sessionServiceName, {
								cwd: opts.cwd,
								logger,
							});
							trace(`Hot reload: swap completed (${Date.now() - swapStart}ms)`);

							trace("Hot reload: complete");
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
