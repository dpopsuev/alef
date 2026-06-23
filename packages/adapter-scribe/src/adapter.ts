import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpAdapter } from "@dpopsuev/alef-adapter-mcp-registry";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { ContextAssemblyHandler } from "@dpopsuev/alef-kernel/pipeline";

export interface ScribeAdapterOptions {
	binary?: string;
	dbPath?: string;
}

/** @deprecated Use ScribeAdapterOptions */
export type ScribeOrganOptions = ScribeAdapterOptions;

const DEFAULT_BINARY = join(homedir(), "Workspace/scribe/bin/scribe");
const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share");
const DEFAULT_DB_PATH = join(XDG_DATA_HOME, "alef", "scribe.db");

const REFRESH_INTERVAL = 10;

export function createScribeOrgan(opts: ScribeAdapterOptions = {}): Adapter {
	const binary = opts.binary ?? DEFAULT_BINARY;
	const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;

	let inner: Adapter | null = null;
	let innerCleanup: (() => void) | null = null;
	let knowledgeSummary = "";
	let recentNotes = "";
	let turnsSinceRefresh = 0;
	let refreshInFlight = false;

	function queryScribe(
		bus: Bus,
		action: string,
		extra: Record<string, unknown>,
		callback: (text: string) => void,
	): void {
		const correlationId = `scribe-${action}-${Date.now()}`;
		const off = bus.event.subscribe("scribe.artifact", (event) => {
			if (event.correlationId !== correlationId) return;
			off();
			const payload = event.payload as { text?: string };
			const text = typeof payload.text === "string" ? payload.text : JSON.stringify(payload);
			if (text && !event.isError) callback(text);
		});
		bus.command.publish({
			type: "scribe.artifact",
			correlationId,
			payload: { action, ...extra },
		});
	}

	function refreshSummary(bus: Bus): void {
		if (refreshInFlight || !inner) return;
		refreshInFlight = true;

		queryScribe(bus, "dashboard", {}, (text) => {
			knowledgeSummary = text;
			traceEvent("scribe:context:dashboard", { chars: text.length });
		});

		queryScribe(
			bus,
			"query",
			{
				kind: "agent.memory",
				sort: "id",
				limit: 5,
				format: "summary",
			},
			(text) => {
				recentNotes = text;
				refreshInFlight = false;
				traceEvent("scribe:context:notes", { chars: text.length });
			},
		);
	}

	const contextStage: ContextAssemblyHandler = async (input) => {
		turnsSinceRefresh++;
		if (turnsSinceRefresh >= REFRESH_INTERVAL) {
			turnsSinceRefresh = 0;
		}

		const block = buildContextBlock(knowledgeSummary, recentNotes);
		if (!block) return {};

		const messages = [...input.messages];
		const systemIdx = messages.findIndex((m) => (m as { role?: string }).role === "system");
		if (systemIdx >= 0) {
			const sys = messages[systemIdx] as { role: string; content: string };
			messages[systemIdx] = { ...sys, content: `${sys.content}\n\n${block}` };
		}
		return { messages };
	};

	const adapter: Adapter = {
		name: "scribe",
		description:
			"Scribe work graph — spawns a dedicated Scribe adapter for artifact tracking, task dispatch, and knowledge management.",
		labels: ["scribe", "blackboard", "planning"] as const,
		tools: [],
		subscriptions: {
			command: [] as readonly string[],
			event: [] as readonly string[],
			notification: [] as readonly string[],
		},
		sources: [{ name: "scribe-db", kind: "process" }] as const,
		directives: [
			"Scribe tools are available under the scribe.* prefix. Use scribe.artifact to create, query, and manage work artifacts. Use scribe.graph for dependency trees and briefings.",
			"To remember something across sessions, create an agent.memory: scribe.artifact(action=create, kind=agent.memory, title='...', sections=[{name:'content', text:'...'}])",
			"When referencing Scribe artifacts in your responses, use [[artifact-id]] wikilink syntax — e.g. [[KRN-ptp-holdover-params]]. Scribe automatically resolves these to graph edges when your turn is recorded, linking your output to the domain knowledge it draws from. Use [[id]] for IDs, [[Title]] for title-based resolution.",
		],
		contributions: {
			"context.assemble": contextStage,
		},

		mount(bus: Bus): () => void {
			mkdirSync(join(dbPath, ".."), { recursive: true });

			traceEvent("scribe:boot", { binary, dbPath });
			const bootPromise = McpAdapter.stdio(binary, ["serve", "--db", dbPath], "scribe")
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
						correlationId: "scribe-boot",
						payload: {
							name: "scribe",
							tools: mcpAdapter.tools.map((t) => ({ name: t.name, description: t.description })),
							contributions: { "context.assemble": contextStage },
						},
						isError: false,
					});

					traceEvent("scribe:ready", { tools: mcpAdapter.tools.length });
					refreshSummary(bus);
				})
				.catch((err: unknown) => {
					traceEvent("scribe:boot:error", { error: String(err) });
					bus.notification.publish({
						type: "adapter.error",
						correlationId: "scribe-boot",
						payload: {
							adapter: "scribe",
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

	return adapter;
}

function buildContextBlock(dashboard: string, notes: string): string {
	if (!dashboard && !notes) return "";
	const parts = [
		"[Scribe Knowledge Base]",
		"Data stored in Scribe persists across sessions.",
		"Use scribe.artifact(action=query, query=<term>) to search.",
		'Use scribe.artifact(action=query, labels=["source:locus"]) to filter by source.',
		"To save a learning: scribe.artifact(action=create, kind=agent.memory, title='...', sections=[{name:'content', text:'...'}])",
		"Reference artifacts with [[artifact-id]] in your text — Scribe auto-links them.",
	];
	if (dashboard) {
		parts.push("", "### Data Sources", dashboard);
	}
	if (notes) {
		parts.push("", "### Agent Memory (from previous sessions)", notes);
	}
	return parts.join("\n");
}
