import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpAdapter } from "@dpopsuev/alef-tool-mcp-registry";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { traceEvent } from "@dpopsuev/alef-kernel/log";

export interface LocusAdapterOptions {
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

export function createLocusAdapter(opts: LocusAdapterOptions = {}): Adapter {
	const binary = opts.binary ?? DEFAULT_BINARY;
	const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
	const historyDir = opts.historyDir ?? DEFAULT_HISTORY_DIR;
	const workspaces = opts.workspaces ?? [];

	let inner: Adapter | null = null;
	let innerCleanup: (() => void) | null = null;

	const adapter: Adapter = {
		name: "locus",
		description:
			"Locus code intelligence — spawns a dedicated Locus adapter for architecture analysis, dependency graphs, symbol search, and diagram rendering.",
		labels: ["locus", "architecture", "analysis"] as const,
		tools: [],
		subscriptions: {
			command: [] as readonly string[],
			event: [] as readonly string[],
			notification: [] as readonly string[],
		},
		sources: [],
		directives: [
			"Locus tools are available under the locus.* prefix. Use locus.codograph to scan repos, locus.analysis for dependency/coupling/impact queries, and locus.render_diagram for Mermaid diagrams.",
		],

		mount(bus: Bus): () => void {
			mkdirSync(cacheDir, { recursive: true });
			mkdirSync(historyDir, { recursive: true });

			const args = ["serve", "--log-level", "warn"];
			for (const ws of workspaces) {
				args.push("--workspace", ws);
			}

			traceEvent("locus:boot", { binary, cacheDir, historyDir, workspaces });
			const bootPromise = McpAdapter.stdio(binary, args, "locus", {
				LOCUS_CACHE_DIR: cacheDir,
				LOCUS_HISTORY_DIR: historyDir,
			})
				.then((mcpAdapter) => {
					inner = mcpAdapter;

					(adapter as { tools: readonly unknown[] }).tools = mcpAdapter.tools;
					(adapter as { subscriptions: { command: readonly string[] } }).subscriptions = {
						...adapter.subscriptions,
						command: mcpAdapter.tools.map((t) => t.name),
					};

					innerCleanup = mcpAdapter.mount(bus);

					bus.event.publish({
						type: "adapter.loaded",
						correlationId: "locus-boot",
						payload: {
							name: "locus",
							tools: mcpAdapter.tools.map((t) => ({ name: t.name, description: t.description })),
						},
						isError: false,
					});

					traceEvent("locus:ready", { tools: mcpAdapter.tools.length });
				})
				.catch((err: unknown) => {
					traceEvent("locus:boot:error", { error: String(err) });
					bus.notification.publish({
						type: "adapter.error",
						correlationId: "locus-boot",
						payload: {
							adapter: "locus",
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

	return adapter;
}
