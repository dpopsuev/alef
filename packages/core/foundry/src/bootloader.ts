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
const DEFAULT_SWAP_TIMEOUT_MS = 60_000;

/**
 * Typed boot lifecycle events (EDA).
 *
 * The bootloader emits these during reboot (warm reboot / kexec-style):
 *   build:start  -- rebuilding code (analogous to loading new kernel image)
 *   build:done   -- build complete
 *   swap:start   -- swapping session service (analogous to kexec jump + init restart)
 *   swap:done    -- swap complete, new session running
 *   complete     -- full reboot cycle finished
 *   error        -- reboot failed at any stage
 */
export type BootEvent =
	| { phase: "build:start"; command: string }
	| { phase: "build:done"; elapsedMs: number }
	| { phase: "swap:start" }
	| { phase: "swap:done"; elapsedMs: number }
	| { phase: "complete"; totalMs: number }
	| { phase: "error"; error: string; elapsedMs: number };

/** Subscriber for boot lifecycle events. */
export type BootEventListener = (event: BootEvent) => void;

/** Handle exposed when the bootloader service starts -- like systemctl reboot. */
export interface RebootHandle {
	/** Warm reboot: rebuild then swap the session service in-process (kexec-style). */
	reboot(): Promise<void>;
}

/** Configuration for the Foundry bootloader service descriptor. */
export interface BootloaderOpts {
	buildCommand: string;
	swap: (serviceName: string, opts: { cwd: string; logger?: AdapterLogger }) => Promise<void>;
	sessionServiceName: string;
	cwd: string;
	/** Called when the reboot handle is ready (service started). */
	onReady?: (handle: RebootHandle) => void;
	/** Called when the bootloader service stops. */
	onStopped?: () => void;
	/** Boot event listener -- receives typed lifecycle events for diagnostics. */
	onEvent?: BootEventListener;
	/** Max time (ms) the swap phase may take before aborting. Default: 60_000. */
	swapTimeoutMs?: number;
}

/** Build a `ServiceDescriptor` for the bootloader service (warm reboot via rebuild + swap). */
export function createBootloaderDescriptor(opts: BootloaderOpts): ServiceDescriptor {
	return defineManagedService({
		name: "bootloader",
		restart: "permanent",
		shareable: true,
		create({ logger }: ServiceCreateOpts) {
			let active = false;
			let rebootInFlight: Promise<void> | undefined;
			const emit = opts.onEvent ?? (() => {});

			const handle: RebootHandle = {
				reboot: async () => {
					if (rebootInFlight) return rebootInFlight;

					rebootInFlight = (async () => {
						const t0 = Date.now();
						emit({ phase: "build:start", command: opts.buildCommand });
						logger?.info({}, "Bootloader: build starting");

						try {
							const { stderr } = await execAsync(opts.buildCommand, {
								cwd: opts.cwd,
								maxBuffer: BUILD_MAX_BUFFER,
								timeout: 120_000,
							});
							const buildMs = Date.now() - t0;
							emit({ phase: "build:done", elapsedMs: buildMs });
							logger?.info({ elapsedMs: buildMs }, "Bootloader: build completed");

							if (stderr) {
								logger?.warn({ stderr }, "Build warnings");
							}

							emit({ phase: "swap:start" });
							const swapStart = Date.now();
							const swapTimeout = opts.swapTimeoutMs ?? DEFAULT_SWAP_TIMEOUT_MS;
							const swapPromise = opts.swap(opts.sessionServiceName, {
								cwd: opts.cwd,
								logger,
							});
							const timeoutPromise = new Promise<never>((_, reject) => {
								setTimeout(() => reject(new Error(`Swap timed out after ${swapTimeout}ms`)), swapTimeout);
							});
							await Promise.race([swapPromise, timeoutPromise]);
							const swapMs = Date.now() - swapStart;
							emit({ phase: "swap:done", elapsedMs: swapMs });
							logger?.info({ elapsedMs: swapMs }, "Bootloader: swap completed");

							emit({ phase: "complete", totalMs: Date.now() - t0 });
							logger?.info({}, "Bootloader: reboot complete");
						} catch (err) {
							emit({ phase: "error", error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - t0 });
							logger?.error({ err }, "Bootloader: reboot failed");
							throw err;
						} finally {
							rebootInFlight = undefined;
						}
					})();

					return rebootInFlight;
				},
			};

			return {
				start() {
					active = true;
					opts.onReady?.(handle);
					logger?.info({}, "Bootloader service ready");
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
