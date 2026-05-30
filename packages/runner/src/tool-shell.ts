/**
 * ToolShellOrgan — progressive disclosure for organ tool schemas (ALE-SPC-42/46).
 *
 * Three-tier context lifecycle (ALE-SPC-46):
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

import type { CorpusHandlerCtx, ToolDefinition } from "@dpopsuev/alef-spine";
import { defineOrgan, toolInputToJsonSchema, typedAction } from "@dpopsuev/alef-spine";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Meta-tool (only tools.describe is exposed to the LLM)
// ---------------------------------------------------------------------------

const DESCRIBE_TOOL = {
	name: "tools.describe",
	description:
		"Get the full schema and usage guidance for one or more tools by name. Call this before using any tool to get its exact parameter names and types.",
	inputSchema: z.object({
		names: z.array(z.string()).describe('Tool names to describe, e.g. ["fs.read", "shell.exec"]'),
	}),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// ToolShellOptions
// ---------------------------------------------------------------------------

export interface ToolShellOptions {
	/** All domain tools available to the agent, captured at construction time. */
	tools: readonly ToolDefinition[];
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
}

// Marker string embedded in the catalog message so eviction can find it.
const CATALOG_MARKER = "\x00TOOL-CATALOG-v1\x00";

// ---------------------------------------------------------------------------
// createToolShellOrgan
// ---------------------------------------------------------------------------

export function createToolShellOrgan(opts: ToolShellOptions) {
	const { tools, organDirectives = new Map<string, readonly string[]>(), evictAfterTurn = 3 } = opts;

	const byName = new Map<string, ToolDefinition>();
	for (const t of tools) byName.set(t.name, t);

	// Mutable lifecycle state — one instance per organ, scoped to this closure.
	const state = {
		catalogInjected: false,
		toolsDescribed: new Set<string>(),
	};

	// ---------------------------------------------------------------------------
	// Internal search (not exposed to LLM — discovery is via boot catalog)
	// ---------------------------------------------------------------------------
	function handleSearch(query: string): Array<{ name: string; description: string }> {
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
		const scored = tools.map((t) => {
			const haystack = `${t.name} ${t.description}`.toLowerCase();
			const score = words.filter((w) => haystack.includes(w)).length;
			return { tool: t, score };
		});
		return scored
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 10)
			.map((s) => ({ name: s.tool.name, description: s.tool.description }));
	}

	// ---------------------------------------------------------------------------
	// Describe — full schema + guidance
	// ---------------------------------------------------------------------------
	function handleDescribe(names: string[]): Array<{
		name: string;
		description: string;
		schema: Record<string, unknown>;
		guidance: string;
	}> {
		const results = [];
		for (const name of names) {
			const t = byName.get(name);
			if (!t) continue;
			state.toolsDescribed.add(name);
			const dirs: readonly string[] = organDirectives.get(name) ?? [];
			const guidance = dirs.join("\n\n");
			const raw: unknown = toolInputToJsonSchema(t.inputSchema);
			const schema = raw as Record<string, unknown>;
			results.push({ name: t.name, description: t.description, schema, guidance });
		}
		return results;
	}

	// ---------------------------------------------------------------------------
	// Catalog message builders
	// ---------------------------------------------------------------------------
	function buildCatalogMessage(): { role: string; content: string } {
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
		return { role: "user", content };
	}

	function buildEvictionMessage(): { role: string; content: string } {
		const used = [...state.toolsDescribed].sort().join(", ") || "none";
		const remaining = tools
			.filter((t) => !state.toolsDescribed.has(t.name))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((t) => t.name)
			.join(", ");
		return {
			role: "user",
			content: `[Tool catalog compacted. Described so far: ${used}. Still available: ${remaining || "none"}. Call tools.describe([name]) to get any tool's schema.]`,
		};
	}

	// ---------------------------------------------------------------------------
	// Message array transformers (pure — no mutation of original)
	// ---------------------------------------------------------------------------
	type RawMsg = Record<string, unknown>;

	function injectCatalog(messages: RawMsg[]): RawMsg[] {
		return [buildCatalogMessage() as unknown as RawMsg, ...messages];
	}

	function evictCatalog(messages: RawMsg[]): RawMsg[] {
		const eviction = buildEvictionMessage() as unknown as RawMsg;
		return messages.map((m) => {
			const content = m.content;
			if (typeof content === "string" && content.startsWith(CATALOG_MARKER)) {
				return eviction;
			}
			return m;
		});
	}

	// ---------------------------------------------------------------------------
	// Organ — motor handlers
	// ---------------------------------------------------------------------------
	const organ = defineOrgan(
		"tools",
		{
			"motor/tools.describe": typedAction(DESCRIBE_TOOL, (ctx) =>
				Promise.resolve({ results: handleDescribe(ctx.payload.names) }),
			),

			// llm.phase — context lifecycle intercept.
			// Activated only when phaseTimeoutMs > 0 in Cerebrum options.
			"motor/llm.phase": {
				handle: (ctx: CorpusHandlerCtx) => {
					const payload = ctx.payload as { messages: RawMsg[]; turn: number };
					let msgs = [...payload.messages];

					if (payload.turn === 1 && !state.catalogInjected) {
						msgs = injectCatalog(msgs);
						state.catalogInjected = true;
					} else if (state.catalogInjected && payload.turn > evictAfterTurn) {
						msgs = evictCatalog(msgs);
					}

					// Return value auto-published to sense/llm.phase by defineOrgan framework.
					return Promise.resolve({ messages: msgs } as Record<string, unknown>);
				},
			},
		},
		{
			description: "Progressive tool discovery — inject catalog once, evict after N turns, describe on demand.",
			directives: [
				'The tool catalog is provided at the start of this conversation. Identify the tool you need, then call tools.describe(["tool-name"]) to get its full schema and call it.',
			],
		},
	);

	// Stripped domain tools: name + description only, no parameter schemas.
	// The LLM can call any tool but must first call tools.describe to learn
	// the parameters. This is the Speakeasy progressive disclosure pattern.
	const strippedTools: ToolDefinition[] = [...tools].map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: z.object({}).passthrough(),
	}));

	return {
		...organ,
		/**
		 * Pass to DialogOrgan.getTools.
		 * Stripped domain tools (name + description, empty schema) + tools.describe.
		 * LLM can call any tool but gets no parameter guidance until it calls describe.
		 */
		metaTools: [...strippedTools, DESCRIBE_TOOL] as ToolDefinition[],
		/** Internal keyword search — not exposed to LLM. */
		search: handleSearch,
		/**
		 * Apply the catalog lifecycle transformation to a messages array.
		 * Exposed for unit testing without needing a motor/sense round-trip.
		 */
		applyPhase(messages: RawMsg[], turn: number): RawMsg[] {
			let msgs = [...messages];
			if (turn === 1 && !state.catalogInjected) {
				msgs = injectCatalog(msgs);
				state.catalogInjected = true;
			} else if (state.catalogInjected && turn > evictAfterTurn) {
				msgs = evictCatalog(msgs);
			}
			return msgs;
		},
	};
}

// ---------------------------------------------------------------------------
// buildBootCatalog — for system prompt fallback (no llm.phase)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildOrganDirectives
// ---------------------------------------------------------------------------

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
