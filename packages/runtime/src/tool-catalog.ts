/**
 * ToolShellOrgan — progressive disclosure for organ tool schemas.
 *
 * Three-tier context lifecycle:
 *
 *   Turn 1 (boot):    Inject compact catalog as synthetic message via context.assemble.
 *                     LLM knows all tools; calls tools.describe for schemas.
 *   Turns 2–N:        Catalog persists in history. No additional cost.
 *   Turn N+1 (evict): Replace catalog message with slim "used/remaining" summary.
 *                     Reclaims ~175 tokens/turn for long sessions.
 *
 * The LLM sees only tools.describe as a callable tool (~50 tokens/call).
 * Full schemas enter the conversation only when the agent explicitly requests them.
 *
 * Token math (N=9 tools, K=2 used, T=3 turns):
 *   Baseline:          T × N × 133 = 3,600 tokens
 *   ToolShell lifecycle: 1×225 + 2×700 = 1,625 tokens  (55% reduction)
 *
 * Measurement: 69.9% of input tokens were schema overhead before this (2026-05-28).
 */

import type { ContextAssemblyHandler, Nerve, OrganLogger, ToolDefinition } from "@dpopsuev/alef-kernel";
import { defineOrgan, toolInputToJsonSchema, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

const DESCRIBE_TOOL = {
	name: "tools.describe",
	description:
		'Get the full schema and usage guidance for one or more tools by name. Pass an empty array to list all available tools. Pass specific names to get full schemas, e.g. tools.describe(["fs.read", "shell.exec"]).',
	inputSchema: z.object({
		names: z.array(z.string()).describe("Tool names to get full schemas for. Pass [] to list all available tools."),
	}),
} satisfies ToolDefinition;

const STATUS_TOOL = {
	name: "tools.status",
	description:
		"List all currently in-flight tool calls with their name, elapsed time, and call ID. Use this to check what is still running during long operations.",
	inputSchema: z.object({}),
} satisfies ToolDefinition;

const CANCEL_TOOL = {
	name: "tools.cancel",
	description:
		"Cancel a specific in-flight tool call by its call ID. The call will be aborted and return an error. Get call IDs from tools.status.",
	inputSchema: z.object({
		callId: z.string().min(1).describe("The call ID to cancel (from tools.status)"),
	}),
} satisfies ToolDefinition;

export interface ToolShellOptions {
	/** All domain tools available to the agent, captured at construction time. */
	tools: readonly ToolDefinition[];
	/**
	 * Live tool list getter. When provided, takes precedence over tools for all
	 * catalog operations so newly plugged organs appear without rebuilding the shell.
	 */
	getTools?: () => readonly ToolDefinition[];
	/**
	 * Organ guidance blocks indexed by tool name.
	 * Populated from organ.directives — travel with schemas instead of system prompt.
	 */
	organDirectives?: ReadonlyMap<string, readonly string[]>;
	/**
	 * Evict the boot catalog from conversation history after this many turns.
	 * Default: 3. Set to Infinity to disable eviction.
	 */
	evictAfterTurn?: number;
	/** Filter which tools appear in the catalog. Unmatched tools are hidden until explicitly described. */
	toolFilter?: (tool: ToolDefinition) => boolean;
	/** Logger for warn/debug output. Defaults to no-op. */
	logger?: OrganLogger;
}

const CATALOG_MARKER = "\x00TOOL-CATALOG-v1\x00";

type RawMsg = Record<string, unknown>;

function getByNameMap(tools: readonly ToolDefinition[]): Map<string, ToolDefinition> {
	const map = new Map<string, ToolDefinition>();
	for (const t of tools) map.set(t.name, t);
	return map;
}

function getStripped(tools: readonly ToolDefinition[]): ToolDefinition[] {
	return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.object({}).passthrough() }));
}

function searchTools(tools: readonly ToolDefinition[], query: string): Array<{ name: string; description: string }> {
	const words = query
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 1);
	if (words.length === 0) {
		return [...tools]
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, 20)
			.map((t) => ({ name: t.name, description: t.description }));
	}
	return tools
		.map((t) => ({
			tool: t,
			score: words.filter((w) => `${t.name} ${t.description}`.toLowerCase().includes(w)).length,
		}))
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 10)
		.map((s) => ({ name: s.tool.name, description: s.tool.description }));
}

function buildCatalogContent(tools: readonly ToolDefinition[]): RawMsg {
	const lines = [...tools]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((t) => `- **${t.name}** — ${t.description}`);
	const content = [
		CATALOG_MARKER,
		"**Available Tools** (complete list — do not call tools.search):",
		'Call `tools.describe(["tool-name"])` to get the full schema before using any tool.',
		"",
		...lines,
	].join("\n");
	const msg: RawMsg = { role: "user", content };
	return msg;
}

function buildEvictionContent(described: Set<string>, tools: readonly ToolDefinition[]): RawMsg {
	const used = [...described].sort().join(", ") || "none";
	const remaining = tools
		.filter((t) => !described.has(t.name))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((t) => t.name)
		.join(", ");
	const msg: RawMsg = {
		role: "user",
		content: `[Tool catalog compacted. Described so far: ${used}. Still available: ${remaining || "none"}. Call tools.describe([name]) to get any tool's schema.]`,
	};
	return msg;
}

function injectCatalogMsg(messages: RawMsg[], tools: readonly ToolDefinition[]): RawMsg[] {
	return [buildCatalogContent(tools), ...messages];
}

function evictCatalogMsg(messages: RawMsg[], described: Set<string>, tools: readonly ToolDefinition[]): RawMsg[] {
	const eviction = buildEvictionContent(described, tools);
	return messages.map((m) => (typeof m.content === "string" && m.content.startsWith(CATALOG_MARKER) ? eviction : m));
}

function namespaceOf(name: string): string {
	return name.includes(".") ? name.slice(0, name.indexOf(".")) : name;
}

interface PromotionTracker {
	promote(name: string): void;
	isPromoted(name: string): boolean;
	described: Set<string>;
}

function createPromotionTracker(): PromotionTracker {
	const promotedPrefixes = new Set<string>();
	const described = new Set<string>();
	return {
		promote(name: string) {
			promotedPrefixes.add(namespaceOf(name));
		},
		isPromoted(name: string) {
			return promotedPrefixes.has(namespaceOf(name));
		},
		described,
	};
}

export function createToolShellAdapter(opts: ToolShellOptions) {
	const { organDirectives = new Map<string, readonly string[]>(), evictAfterTurn = 3, logger } = opts;

	const resolveTools = opts.getTools ?? (() => opts.tools);

	let catalogInjected = false; // lint-ignore: RAWTIMER not a timer — mutable lifecycle flag
	const tracker = createPromotionTracker();

	const inflightCalls = new Map<string, { name: string; startedAt: number; callId: string }>();
	let cancelCall: ((callId: string) => void) | null = null;

	function handleDescribe(
		names: string[],
		log: OrganLogger,
	): Array<{ name: string; description: string; schema: Record<string, unknown>; guidance: string }> {
		const tools = resolveTools();
		const byName = getByNameMap(tools);
		if (names.length === 0) {
			return [...tools]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((t) => ({ name: t.name, description: t.description, schema: {}, guidance: "" }));
		}
		const results = [];
		for (const name of names) {
			const t = byName.get(name);
			if (!t) {
				log.warn({ name, available: [...byName.keys()] }, "tools:describe:miss");
				continue;
			}
			tracker.described.add(name);
			tracker.promote(name);
			results.push({
				name: t.name,
				description: t.description,
				schema: toolInputToJsonSchema(t.inputSchema),
				guidance: (organDirectives.get(name) ?? []).join("\n\n"),
			});
		}
		return results;
	}

	function getPromotedTools(): ToolDefinition[] {
		const tools = resolveTools();
		const stripped = getStripped(tools);
		const promoted = tools.map((t) =>
			tracker.isPromoted(t.name) ? t : (stripped.find((s) => s.name === t.name) ?? t),
		);
		return [...promoted, DESCRIBE_TOOL];
	}

	// ---------------------------------------------------------------------------
	// Organ — motor handlers
	// ---------------------------------------------------------------------------
	const organ = defineOrgan(
		"tools",
		{
			motor: {
				"tools.describe": typedAction(DESCRIBE_TOOL, (ctx) => {
					const results = handleDescribe(ctx.payload.names, ctx.log);
					const displayText =
						ctx.payload.names.length === 0
							? `Available tools: ${results.map((t) => t.name).join(", ")}`
							: results.map((t) => `${t.name}: ${t.description}`).join("\n");
					return Promise.resolve(withDisplay({ results }, { text: displayText, mimeType: "text/plain" }));
				}),
				"tools.status": typedAction(STATUS_TOOL, () => {
					const now = Date.now();
					const calls = [...inflightCalls.values()].map((c) => ({
						callId: c.callId,
						name: c.name,
						elapsedMs: now - c.startedAt,
					}));
					const text =
						calls.length === 0
							? "No tool calls in flight."
							: calls
									.map((c) => `${c.name} (${c.callId.slice(0, 8)}) — ${Math.round(c.elapsedMs / 1000)}s`)
									.join("\n");
					return Promise.resolve(withDisplay({ calls }, { text, mimeType: "text/plain" }));
				}),
				"tools.cancel": typedAction(CANCEL_TOOL, (ctx) => {
					const { callId } = ctx.payload;
					const entry = inflightCalls.get(callId);
					if (!entry) {
						return Promise.resolve(
							withDisplay(
								{ cancelled: false, error: "not found" },
								{ text: `No in-flight call with ID ${callId}`, mimeType: "text/plain" },
							),
						);
					}
					cancelCall?.(callId);
					return Promise.resolve(
						withDisplay(
							{ cancelled: true, name: entry.name },
							{ text: `Cancelled ${entry.name} (${callId.slice(0, 8)})`, mimeType: "text/plain" },
						),
					);
				}),
			},
		},
		{
			description: "Progressive tool discovery — inject catalog once, evict after N turns, describe on demand.",
			directives: [
				'The tool catalog is provided at the start of this conversation. To get the full schema for a tool, call tools.describe(["tool-name"]). To rediscover all available tools at any time, call tools.describe([]) — it returns the complete catalog. Never guess tool names or parameter shapes.',
			],
			logger,
		},
	);

	function mountWithPromotion(nerve: Nerve): () => void {
		const unmount = organ.mount(nerve);
		const offSense = nerve.sense.subscribe("*", (event) => {
			if (getByNameMap(resolveTools()).has(event.type)) {
				tracker.promote(event.type);
			}
		});
		const offStart = nerve.signal.subscribe("llm.tool-start", (event) => {
			const p = event.payload as { callId?: string; name?: string };
			if (p.callId && p.name) {
				inflightCalls.set(p.callId, { callId: p.callId, name: p.name, startedAt: Date.now() });
			}
		});
		const offEnd = nerve.signal.subscribe("llm.tool-end", (event) => {
			const p = event.payload as { callId?: string };
			if (p.callId) inflightCalls.delete(p.callId);
		});
		cancelCall = (callId: string) => {
			nerve.signal.publish({ type: "tools.cancel-request", payload: { callId }, correlationId: "" });
		};
		return () => {
			unmount();
			offSense();
			offStart();
			offEnd();
			cancelCall = null;
			inflightCalls.clear();
		};
	}

	const shell = {
		...organ,
		mount: mountWithPromotion,
		get metaTools(): ToolDefinition[] {
			return [...getStripped(resolveTools()), DESCRIBE_TOOL];
		},
		currentMetaTools: getPromotedTools,
		search: (query: string) => searchTools(resolveTools(), query),
		applyPhase(messages: RawMsg[], turn: number): RawMsg[] {
			let msgs = [...messages];
			if (turn === 1 && !catalogInjected) {
				msgs = injectCatalogMsg(msgs, resolveTools());
				catalogInjected = true;
			} else if (catalogInjected && turn > evictAfterTurn) {
				msgs = evictCatalogMsg(msgs, tracker.described, resolveTools());
			}
			return msgs;
		},
		phaseStage(): ContextAssemblyHandler {
			return ({ messages, turn }) => {
				const msgs = shell.applyPhase(messages as unknown as RawMsg[], turn) as unknown as typeof messages;
				return Promise.resolve({ messages: msgs, tools: getPromotedTools() });
			};
		},
	};

	shell.contributions = {
		"context.assemble": shell.phaseStage(),
		"schema-resolver": (name: string) => {
			const tools = resolveTools();
			return tools.find((t) => t.name === name);
		},
	};

	return shell;
}

/**
 * Compact tool catalog string for system prompt injection.
 * Used as fallback when phaseTimeoutMs is not set (context.assemble seam inactive).
 */
export function buildBootCatalog(tools: readonly ToolDefinition[]): string {
	const lines = tools
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((t) => `- **${t.name}** — ${t.description}`);

	return [
		"## Available Tools",
		"",
		'This is the complete tool list. Do NOT call `tools.search`. Instead: call `tools.describe(["tool-name"])` to get the full schema for any tool you plan to use, then call the tool.',
		"",
		...lines,
	].join("\n");
}

export function buildAdapterDirectives(
	adapters: readonly { tools: readonly ToolDefinition[]; directives?: readonly string[] }[],
): ReadonlyMap<string, readonly string[]> {
	const map = new Map<string, readonly string[]>();
	for (const adapter of adapters) {
		if (!adapter.directives?.length) continue;
		for (const tool of adapter.tools) {
			map.set(tool.name, adapter.directives);
		}
	}
	return map;
}

/** @deprecated Use createToolShellAdapter */
export const createToolShellOrgan = createToolShellAdapter;
/** @deprecated Use buildAdapterDirectives */
export const buildOrganDirectives = buildAdapterDirectives;
