import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextAssemblyHandler, Nerve, Organ } from "@dpopsuev/alef-kernel";
import { debugLog, McpOrgan } from "@dpopsuev/alef-kernel";

export interface ScribeOrganOptions {
	/** Path to the scribe binary. Defaults to ~/Workspace/scribe/bin/scribe */
	binary?: string;
	/** Path to the SQLite database. Defaults to $XDG_DATA_HOME/alef/scribe.db */
	dbPath?: string;
}

const DEFAULT_BINARY = join(homedir(), "Workspace/scribe/bin/scribe");
const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share");
const DEFAULT_DB_PATH = join(XDG_DATA_HOME, "alef", "scribe.db");

export function createScribeOrgan(opts: ScribeOrganOptions = {}): Organ {
	const binary = opts.binary ?? DEFAULT_BINARY;
	const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;

	let inner: Organ | null = null;
	let innerCleanup: (() => void) | null = null;
	const activeTaskId = "";
	const activeTaskTitle = "";

	const contextStage: ContextAssemblyHandler = async (input) => {
		if (!activeTaskId || !activeTaskTitle) return {};

		const contextBlock = `[Active Task] ${activeTaskTitle} (${activeTaskId})`;
		const messages = [...input.messages];
		const systemIdx = messages.findIndex((m) => (m as { role?: string }).role === "system");
		if (systemIdx >= 0) {
			const sys = messages[systemIdx] as { role: string; content: string };
			messages[systemIdx] = { ...sys, content: `${sys.content}\n\n${contextBlock}` };
		}
		return { messages };
	};

	const organ: Organ = {
		name: "scribe",
		description:
			"Scribe work graph — spawns a dedicated Scribe instance for artifact tracking, task dispatch, and knowledge management.",
		labels: ["scribe", "blackboard", "planning"] as const,
		tools: [],
		subscriptions: { motor: [] as readonly string[], sense: [] as readonly string[] },
		directives: [
			"Scribe tools are available under the scribe.* prefix. Use scribe.artifact to create, query, and manage work artifacts. Use scribe.graph for dependency trees and briefings.",
		],
		contributions: {
			"context.assemble": contextStage,
		},

		mount(nerve: Nerve): () => void {
			mkdirSync(join(dbPath, ".."), { recursive: true });

			debugLog("scribe:boot", { binary, dbPath });
			const bootPromise = McpOrgan.stdio(binary, ["serve", "--db", dbPath], "scribe")
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
						correlationId: "scribe-boot",
						payload: {
							name: "scribe",
							tools: mcpOrgan.tools.map((t) => ({ name: t.name, description: t.description })),
							contributions: { "context.assemble": contextStage },
						},
						isError: false,
					});

					debugLog("scribe:ready", { tools: mcpOrgan.tools.length });
				})
				.catch((err: unknown) => {
					debugLog("scribe:boot:error", { error: String(err) });
					nerve.signal.publish({
						type: "organ.error",
						correlationId: "scribe-boot",
						payload: {
							organ: "scribe",
							message: `Failed to start Scribe: ${err instanceof Error ? err.message : String(err)}`,
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
