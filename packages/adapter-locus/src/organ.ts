import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Nerve, Organ } from "@dpopsuev/alef-kernel";
import { debugLog, McpOrgan } from "@dpopsuev/alef-kernel";

export interface LocusOrganOptions {
	/** Workspace root(s) to analyze. Defaults to cwd. */
	workspaces?: string[];
	/** Path to the locus binary. Defaults to ~/Workspace/locus/locus */
	binary?: string;
	/** Cache directory. Defaults to $XDG_DATA_HOME/alef/locus/cache */
	cacheDir?: string;
	/** History directory. Defaults to $XDG_DATA_HOME/alef/locus/history */
	historyDir?: string;
}

const DEFAULT_BINARY = join(homedir(), "Workspace/locus/locus");
const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share");
const DEFAULT_CACHE_DIR = join(XDG_DATA_HOME, "alef", "locus", "cache");
const DEFAULT_HISTORY_DIR = join(XDG_DATA_HOME, "alef", "locus", "history");

export function createLocusOrgan(opts: LocusOrganOptions = {}): Organ {
	const binary = opts.binary ?? DEFAULT_BINARY;
	const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
	const historyDir = opts.historyDir ?? DEFAULT_HISTORY_DIR;
	const workspaces = opts.workspaces ?? [];

	let inner: Organ | null = null;
	let innerCleanup: (() => void) | null = null;

	const organ: Organ = {
		name: "locus",
		description:
			"Locus code intelligence — spawns a dedicated Locus instance for architecture analysis, dependency graphs, symbol search, and diagram rendering.",
		labels: ["locus", "architecture", "analysis"] as const,
		tools: [],
		subscriptions: { motor: [] as readonly string[], sense: [] as readonly string[] },
		sources: [],
		directives: [
			"Locus tools are available under the locus.* prefix. Use locus.codograph to scan repos, locus.analysis for dependency/coupling/impact queries, and locus.render_diagram for Mermaid diagrams.",
		],

		mount(nerve: Nerve): () => void {
			mkdirSync(cacheDir, { recursive: true });
			mkdirSync(historyDir, { recursive: true });

			const args = ["serve", "--log-level", "warn"];
			for (const ws of workspaces) {
				args.push("--workspace", ws);
			}

			debugLog("locus:boot", { binary, cacheDir, historyDir, workspaces });
			const bootPromise = McpOrgan.stdio(binary, args, "locus", {
				LOCUS_CACHE_DIR: cacheDir,
				LOCUS_HISTORY_DIR: historyDir,
			})
				.then((mcpOrgan) => {
					inner = mcpOrgan;

					(organ as { tools: readonly unknown[] }).tools = mcpOrgan.tools;
					(organ as { subscriptions: { motor: readonly string[] } }).subscriptions = {
						...organ.subscriptions,
						motor: mcpOrgan.tools.map((t) => t.name),
					};

					innerCleanup = mcpOrgan.mount(nerve);

					nerve.sense.publish({
						type: "organ.loaded",
						correlationId: "locus-boot",
						payload: {
							name: "locus",
							tools: mcpOrgan.tools.map((t) => ({ name: t.name, description: t.description })),
						},
						isError: false,
					});

					debugLog("locus:ready", { tools: mcpOrgan.tools.length });
				})
				.catch((err: unknown) => {
					debugLog("locus:boot:error", { error: String(err) });
					nerve.signal.publish({
						type: "organ.error",
						correlationId: "locus-boot",
						payload: {
							organ: "locus",
							message: `Failed to start Locus: ${err instanceof Error ? err.message : String(err)}`,
						},
					});
				});

			void bootPromise;

			return () => {
				innerCleanup?.();
				if (inner && "close" in inner && typeof inner.close === "function") {
					(inner.close as () => Promise<void>)().catch(() => {});
				}
				inner = null;
				innerCleanup = null;
			};
		},
	};

	return organ;
}
