/**
 * ToolShellOrgan — progressive disclosure for organ tool schemas.
 *
 * Three-tier context lifecycle:
 *
 *   Turn 1 (boot):    Inject compact catalog as synthetic message via llm.phase.
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

import type { Nerve, OrganLogger, ToolDefinition } from "@dpopsuev/alef-kernel";
import { defineOrgan, toolInputToJsonSchema, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import type { PhaseStageHandler } from "@dpopsuev/alef-organ-llm";
import { z } from "zod";

const DESCRIBE_TOOL = {
	name: "tools.describe",
	description:
		'Get the full schema and usage guidance for one or more tools by name. Pass an empty array to list all available tools. Pass specific names to get full schemas, e.g. tools.describe(["fs.read", "shell.exec"]).',
	inputSchema: z.object({
		names: z.array(z.string()).describe("Tool names to get full schemas for. Pass [] to list all available tools."),
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
	return { role: "user", content } as unknown as RawMsg;
}

function buildEvictionContent(described: Set<string>, tools: readonly ToolDefinition[]): RawMsg {
	const used = [...described].sort().join(", ") || "none";
	const remaining = tools
		.filter((t) => !described.has(t.name))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((t) => t.name)
		.join(", ");
	return {
		role: "user",
		content: `[Tool catalog compacted. Described so far: ${used}. Still available: ${remaining || "none"}. Call tools.describe([name]) to get any tool's schema.]`,
	} as unknown as RawMsg;
}

function injectCatalogMsg(messages: RawMsg[], tools: readonly ToolDefinition[]): RawMsg[] {
	return [buildCatalogContent(tools), ...messages];
}

function evictCatalogMsg(messages: RawMsg[], described: Set<string>, tools: readonly ToolDefinition[]): RawMsg[] {
	const eviction = buildEvictionContent(described, tools);
	return messages.map((m) =>
		typeof m.content === "string" && (m.content as string).startsWith(CATALOG_MARKER) ? eviction : m,
	);
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

export function createToolShellOrgan(opts: ToolShellOptions) {
	const { organDirectives = new Map<string, readonly string[]>(), evictAfterTurn = 3, logger } = opts;

	const resolveTools = opts.getTools ?? (() => opts.tools);

	let catalogInjected = false; // lint-ignore: RAWTIMER not a timer — mutable lifecycle flag
	const tracker = createPromotionTracker();

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
			// Promote the whole namespace so the LLM avoids a second describe round-trip.
			tracker.promote(name);
			results.push({
				name: t.name,
				description: t.description,
				schema: toolInputToJsonSchema(t.inputSchema) as Record<string, unknown>,
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
			"motor/tools.describe": typedAction(DESCRIBE_TOOL, (ctx) => {
				const results = handleDescribe(ctx.payload.names, ctx.log);
				const displayText =
					ctx.payload.names.length === 0
						? `Available tools: ${results.map((t) => t.name).join(", ")}`
						: results.map((t) => `${t.name}: ${t.description}`).join("\n");
				return Promise.resolve(withDisplay({ results }, { text: displayText, mimeType: "text/plain" }));
			}),
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
		// Auto-promote families when domain tools return Sense results.
		// Triggers even when the LLM skips tools.describe and calls a tool
		// directly — so the next turn's currentMetaTools() returns full schemas
		// for all sibling tools without a second describe round-trip.
		const offSense = nerve.sense.subscribe("*", (event) => {
			if (getByNameMap(resolveTools()).has(event.type)) {
				tracker.promote(event.type);
			}
		});
		return () => {
			unmount();
			offSense();
		};
	}

	const shell = {
		...organ,
		mount: mountWithPromotion,
		/**
		 * Static snapshot: all tools stripped + tools.describe.
		 * Use currentMetaTools() in getTools callbacks instead — it promotes
		 * described tools to full schemas so the LLM avoids repeat describe calls.
		 */
		get metaTools(): ToolDefinition[] {
			return [...getStripped(resolveTools()), DESCRIBE_TOOL];
		},
		/**
		 * Dynamic tool list for getTools callbacks.
		 *
		 * Family promotion: once any tool in a namespace is described or called,
		 * all tools sharing that prefix get full schemas in the next turn.
		 * Describing or calling "fs.read" promotes fs.edit, fs.write, etc.
		 *
		 * Also returned by the motor/llm.phase handler so organ-llm refreshes
		 * schemas on each iteration without waiting for the next dialog.send().
		 */
		currentMetaTools: getPromotedTools,
		/** Internal keyword search — not exposed to LLM. */
		search: (query: string) => searchTools(resolveTools(), query),
		/**
		 * Apply the catalog lifecycle transformation to a messages array.
		 * Exposed for unit testing without needing a motor/sense round-trip.
		 */
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
		phaseStage(): PhaseStageHandler {
			return ({ messages, turn }) => {
				const msgs = shell.applyPhase(messages as unknown as RawMsg[], turn) as unknown as typeof messages;
				return Promise.resolve({ messages: msgs, tools: getPromotedTools() });
			};
		},
	};

	shell.contributions = {
		"llm.phase": shell.phaseStage(),
		"schema-resolver": (name: string) => {
			// Always re-read from live resolveTools() so newly loaded organs are visible
			const tools = resolveTools();
			return tools.find((t) => t.name === name);
		},
	};

	return shell;
}

/**
 * Compact tool catalog string for system prompt injection.
 * Used as fallback when phaseTimeoutMs is not set (llm.phase seam inactive).
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

export function buildOrganDirectives(
	organs: readonly { tools: readonly ToolDefinition[]; directives?: readonly string[] }[],
): ReadonlyMap<string, readonly string[]> {
	const map = new Map<string, readonly string[]>();
	for (const organ of organs) {
		if (!organ.directives?.length) continue;
		for (const tool of organ.tools) {
			map.set(tool.name, organ.directives);
		}
	}
	return map;
}
