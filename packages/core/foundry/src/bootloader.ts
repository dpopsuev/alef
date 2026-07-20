import { exec, type ExecOptions } from "node:child_process";
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

/**
 * Build lifecycle events.
 *
 *   build:start  -- compilation starting
 *   build:done   -- compilation finished
 *   error        -- build failed
 */
export type BuildEvent =
	| { phase: "build:start"; command: string }
	| { phase: "build:done"; elapsedMs: number }
	| { phase: "error"; error: string; elapsedMs: number };

/**
 *
 */
export type BuildEventListener = (event: BuildEvent) => void;

/**
 * Single-responsibility build capability.
 * The caller decides what to do after the build completes (exit, swap, etc.).
 */
export interface BuildService {
	build(): Promise<void>;
}

/**
 *
 */
export interface BuildServiceOpts {
	buildCommand: string;
	cwd: string;
	onReady?: (service: BuildService) => void;
	onStopped?: () => void;
	onEvent?: BuildEventListener;
}

/**
 * Foundry service descriptor that exposes a BuildService.
 * SRP: this service only compiles code. It does not swap sessions,
 * manage process lifecycle, or decide restart strategy.
 */
export function createBuildServiceDescriptor(opts: BuildServiceOpts): ServiceDescriptor {
	return defineManagedService({
		name: "build",
		restart: "permanent",
		shareable: true,
		create({ logger }: ServiceCreateOpts) {
			let active = false;
			let buildInFlight: Promise<void> | undefined;
			const emit = opts.onEvent ?? (() => {});

			const service: BuildService = {
				build: async () => {
					if (buildInFlight) return buildInFlight;

					buildInFlight = (async () => {
						const t0 = Date.now();
						emit({ phase: "build:start", command: opts.buildCommand });
						logger?.info({}, "Build: starting");

						try {
							const { stderr } = await execAsync(opts.buildCommand, {
								cwd: opts.cwd,
								maxBuffer: BUILD_MAX_BUFFER,
								timeout: 120_000,
							});
							const elapsedMs = Date.now() - t0;
							emit({ phase: "build:done", elapsedMs });
							logger?.info({ elapsedMs }, "Build: completed");

							if (stderr) {
								logger?.warn({ stderr }, "Build warnings");
							}
						} catch (err) {
							const elapsedMs = Date.now() - t0;
							emit({ phase: "error", error: err instanceof Error ? err.message : String(err), elapsedMs });
							logger?.error({ err }, "Build: failed");
							throw err;
						} finally {
							buildInFlight = undefined;
						}
					})();

					return buildInFlight;
				},
			};

			return {
				start() {
					active = true;
					opts.onReady?.(service);
					logger?.info({}, "Build service ready");
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

// -- Backward compatibility aliases --

/** @deprecated Use BuildEvent. */
export type BootEvent =
	| BuildEvent
	| { phase: "swap:start" }
	| { phase: "swap:done"; elapsedMs: number }
	| { phase: "complete"; totalMs: number };

/** @deprecated Use BuildEventListener. */
export type BootEventListener = (event: BootEvent) => void;

/** @deprecated Use BuildService. */
export type RebootHandle = BuildService;

/** @deprecated Use BuildServiceOpts. */
export type BootloaderOpts = BuildServiceOpts;

/** @deprecated Use createBuildServiceDescriptor. */
export const createBootloaderDescriptor = createBuildServiceDescriptor;
