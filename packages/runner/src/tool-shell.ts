/**
 * ToolShellOrgan — progressive disclosure for organ tool schemas.
 *
 * Replaces full upfront schema injection with two meta-tools:
 *   tools.search   { query }   → [{ name, description }]
 *   tools.describe { names[] } → [{ name, description, schema, guidance }]
 *
 * The LLM receives only the meta-tool schemas (~100 tokens) instead of all
 * domain tool schemas (~1200+ tokens). Full schemas load on demand.
 *
 * Implements ALE-ADR-9 / ALE-SPC-42.
 * Measurement: 69.9% of input tokens were schema overhead before this.
 */

import type { ToolDefinition } from "@dpopsuev/alef-spine";
import { defineOrgan, toolInputToJsonSchema, typedAction } from "@dpopsuev/alef-spine";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Meta-tool definitions (keep as const so typedAction infers payload type)
// ---------------------------------------------------------------------------

// tools.search is intentionally NOT exposed as a callable meta-tool.
// Discovery is handled by the boot catalog in the system prompt (buildBootCatalog).
// Exposing search causes LLMs to call it reflexively even when the catalog
// already answers the question, adding a wasteful round-trip per tool use.
const DESCRIBE_TOOL = {
	name: "tools.describe",
	description:
		"Get the full schema and usage guidance for one or more tools by name. Call this before using any tool to get its exact parameter names and types.",
	inputSchema: z.object({
		names: z.array(z.string()).describe('Tool names to describe, e.g. ["fs.read", "shell.exec"]'),
	}),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// ToolShellOrgan
// ---------------------------------------------------------------------------

export interface ToolShellOptions {
	/** All domain tools available to the agent, captured at construction time. */
	tools: readonly ToolDefinition[];
	/**
	 * Organ guidance blocks indexed by tool name.
	 * Populated from organ.directives — these move here from the system prompt.
	 */
	organDirectives?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Build a ToolShellOrgan from a snapshot of all domain tools.
 *
 * The returned organ exposes two motor handlers (tools.search, tools.describe).
 * Pass toolShell.metaTools to DialogOrgan.getTools instead of () => agent.tools.
 */
export function createToolShellOrgan(opts: ToolShellOptions) {
	const { tools, organDirectives = new Map<string, readonly string[]>() } = opts;

	// Index tools by name for O(1) describe lookup.
	const byName = new Map<string, ToolDefinition>();
	for (const t of tools) byName.set(t.name, t);

	// ---------------------------------------------------------------------------
	// tools.search — keyword match on name + description, returns slim results
	// ---------------------------------------------------------------------------
	function handleSearch(query: string): Array<{ name: string; description: string }> {
		const words = query
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w.length > 1);
		if (words.length === 0) {
			// Empty query: return all tools (sorted alphabetically, capped at 20)
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
	// tools.describe — full schema + guidance, returns rich results
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
			const dirs: readonly string[] = organDirectives.get(name) ?? [];
			const guidance = dirs.join("\n\n");
			// toolInputToJsonSchema returns an untyped object; double-cast via unknown.
			const raw: unknown = toolInputToJsonSchema(t.inputSchema);
			const schema = raw as Record<string, unknown>;
			results.push({ name: t.name, description: t.description, schema, guidance });
		}
		return results;
	}

	// ---------------------------------------------------------------------------
	// Organ
	// ---------------------------------------------------------------------------
	const organ = defineOrgan(
		"tools",
		{
			"motor/tools.describe": typedAction(DESCRIBE_TOOL, (ctx) => {
				return Promise.resolve({ results: handleDescribe(ctx.payload.names) });
			}),
		},
		{
			description: "Progressive tool discovery — describe domain tools on demand to get their full schema.",
			directives: [
				'The Available Tools section in the system prompt lists every tool. Workflow: 1. Identify the tool from the system prompt list. 2. Call tools.describe(["tool-name"]) to get its full schema and guidance. 3. Call the tool with the correct parameters.',
			],
		},
	);

	return {
		...organ,
		/**
		 * Pass to DialogOrgan.getTools instead of () => agent.tools.
		 * Only tools.describe is exposed — discovery is via boot catalog in system prompt.
		 */
		metaTools: [DESCRIBE_TOOL] as const,
		/** Internal search — available for programmatic use, not exposed to LLM. */
		search: handleSearch,
	};
}

// ---------------------------------------------------------------------------
// Boot catalog — compact tool list for system prompt injection
// ---------------------------------------------------------------------------

/**
 * Build a compact tool catalog for the system prompt.
 *
 * The catalog gives the LLM upfront awareness of all available tools
 * so it can skip tools.search and go straight to tools.describe.
 * Each entry is ~25 tokens; 9 tools ≈ 225 tokens total — one-time cost
 * amortized across all turns vs ~1200 tokens of full schemas per turn.
 *
 * Format:
 *   ## Available Tools
 *   Call tools.describe(["name"]) to get the full schema before using a tool.
 *   - fs.read — Read raw text from a file
 *   - fs.grep — Search file contents by regex pattern
 *   ...
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
// Helper — build organDirectives map from loaded organs
// ---------------------------------------------------------------------------

/**
 * Build the tool→directives index from a set of loaded organs.
 * Each tool in an organ inherits all of that organ's directive strings.
 */
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
