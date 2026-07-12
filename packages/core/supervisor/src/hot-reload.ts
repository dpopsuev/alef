import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import type { ServiceCreateOpts, ServiceDescriptor } from "./lifecycle.js";

const execAsync = promisify(exec);

type AlefGlobal = typeof globalThis & {
	alefRequestRebuild?: () => Promise<void>;
};

interface HotReloadOpts {
	buildCommand: string;
	swap: (serviceName: string, opts: { cwd: string; logger?: AdapterLogger }) => Promise<void>;
	sessionServiceName: string;
	cwd: string;
}

/**
 *
 */
export function createHotReloadDescriptor(opts: HotReloadOpts): ServiceDescriptor {
	return {
		name: "hot-reload",
		restart: "permanent",
		shareable: true,

		// eslint-disable-next-line @typescript-eslint/require-await -- ServiceDescriptor.create returns Promise
		async create({ logger }: ServiceCreateOpts) {
			let active = false;
			let rebuildInFlight: Promise<void> | undefined;
			const globalRef = globalThis as AlefGlobal;

			globalRef.alefRequestRebuild = async () => {
				if (rebuildInFlight) {
					return rebuildInFlight;
				}

				rebuildInFlight = (async () => {
					logger?.info({}, "Hot reload: build starting");

					try {
						const { stderr } = await execAsync(opts.buildCommand, {
							cwd: opts.cwd,
						});

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
			};

			return {
				name: "hot-reload",
				restart: "permanent" as const,
				adapters: [],
				tools: [],

				// eslint-disable-next-line @typescript-eslint/require-await -- ManagedLifecycle.start returns Promise
				async start() {
					active = true;
					logger?.info({}, "Hot reload service ready");
				},

				// eslint-disable-next-line @typescript-eslint/require-await -- ManagedLifecycle.stop returns Promise
				async stop() {
					delete globalRef.alefRequestRebuild;
					active = false;
				},

				// eslint-disable-next-line @typescript-eslint/require-await -- ManagedLifecycle.health returns Promise
				async health() {
					return active;
				},
			};
		},
	};
}
