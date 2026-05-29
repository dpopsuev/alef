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

const SEARCH_TOOL = {
	name: "tools.search",
	description:
		"Search available tools by keyword. Returns tool names and one-line descriptions. Call this first to find the right tool, then call tools.describe to get the full schema before using it.",
	inputSchema: z.object({
		query: z.string().describe("Keywords to search for in tool names and descriptions"),
	}),
} satisfies ToolDefinition;

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
			"motor/tools.search": typedAction(SEARCH_TOOL, (ctx) => {
				return Promise.resolve({ results: handleSearch(ctx.payload.query) });
			}),
			"motor/tools.describe": typedAction(DESCRIBE_TOOL, (ctx) => {
				return Promise.resolve({ results: handleDescribe(ctx.payload.names) });
			}),
		},
		{
			description: "Progressive tool discovery — search and describe domain tools on demand.",
			directives: [
				"Always call tools.search first to find the right tool by keyword, then call tools.describe to get its full schema before using it. Never guess parameter names — always describe first.",
			],
		},
	);

	return {
		...organ,
		/** Pass these to DialogOrgan.getTools instead of () => agent.tools. */
		metaTools: [SEARCH_TOOL, DESCRIBE_TOOL] as const,
	};
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
