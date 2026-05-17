/**
 * DirectiveContextAssembler — weighted, budget-aware system prompt assembly.
 *
 * Two-level ACI (Anthropic Appendix 2):
 *   Level 1: ToolDefinition.description — brief one-liner per tool (in tool list)
 *   Level 2: Organ.directives — full usage guidance in the system prompt
 *
 * Directive layers (priority order, highest weight included first):
 *   workspace  (100) — .alef/directives/*.md — operator rules for this repo
 *   organ       (80) — declared by each organ alongside its tools
 *   global      (60) — hardcoded baseline (ACI coding standards)
 *
 * Budget: estimated chars (* 4 ≈ tokens). When budget is exceeded, lowest-weight
 * directives are dropped. Recent additions (higher weight) always survive.
 *
 * Usage:
 *   const asm = new DirectiveContextAssembler(basePrompt)
 *   await asm.loadWorkspace(cwd)
 *   asm.registerOrgans(agent.organs)
 *   const systemPrompt = asm.build(200_000)
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Organ } from "@dpopsuev/alef-spine";

// ---------------------------------------------------------------------------
// Directive type
// ---------------------------------------------------------------------------

export interface Directive {
	/** Unique identifier — used for deduplication. */
	id: string;
	/** Layer determines default weight and precedence. */
	layer: "global" | "workspace" | "organ";
	/** Guidance content — markdown or prose. */
	content: string;
	/**
	 * Priority within the assembled prompt. Higher = included first.
	 * Default per layer: workspace=100, organ=80, global=60.
	 */
	weight: number;
}

const DEFAULT_WEIGHTS: Record<Directive["layer"], number> = {
	workspace: 100,
	organ: 80,
	global: 60,
};

// ---------------------------------------------------------------------------
// DirectiveContextAssembler
// ---------------------------------------------------------------------------

export class DirectiveContextAssembler {
	private readonly base: string;
	private readonly directives: Directive[] = [];
	private readonly seenIds = new Set<string>();

	constructor(basePrompt: string) {
		this.base = basePrompt;
	}

	/** Add a single directive. Deduplicates by id. */
	register(directive: Directive): void {
		if (this.seenIds.has(directive.id)) return;
		this.seenIds.add(directive.id);
		this.directives.push(directive);
	}

	/**
	 * Collect directives from all loaded organs.
	 * Organs declare `directives?: readonly string[]` — each string becomes a
	 * Directive with layer='organ' and the organ name as id prefix.
	 */
	registerOrgans(organs: readonly Organ[]): void {
		for (const organ of organs) {
			if (!organ.directives?.length) continue;
			organ.directives.forEach((content, i) => {
				this.register({
					id: `organ.${organ.name}.${i}`,
					layer: "organ",
					content: content.trim(),
					weight: DEFAULT_WEIGHTS.organ,
				});
			});
		}
	}

	/**
	 * Load workspace-specific directives from `.alef/directives/*.md`.
	 * These are operator rules for a specific repo — highest priority.
	 * Silently skips if the directory does not exist.
	 */
	async loadWorkspace(cwd: string): Promise<void> {
		const dir = join(cwd, ".alef", "directives");
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return; // Directory doesn't exist — fine
		}

		const mdFiles = entries.filter((e) => e.endsWith(".md")).sort();
		for (const file of mdFiles) {
			try {
				const content = (await readFile(join(dir, file), "utf-8")).trim();
				if (content) {
					this.register({
						id: `workspace.${file}`,
						layer: "workspace",
						content,
						weight: DEFAULT_WEIGHTS.workspace,
					});
				}
			} catch {
				// Skip unreadable files
			}
		}
	}

	/**
	 * Assemble the system prompt.
	 * Directives sorted by weight descending — highest priority first.
	 * When budget is set, lowest-weight directives are dropped to fit.
	 *
	 * @param budgetChars  Approximate character budget for directive blocks.
	 *                     Default: unlimited. 4 chars ≈ 1 token.
	 */
	build(budgetChars?: number): string {
		if (this.directives.length === 0) return this.base;

		const sorted = [...this.directives].sort((a, b) => b.weight - a.weight);

		const selected: Directive[] = [];
		let usedChars = 0;

		for (const d of sorted) {
			const cost = d.content.length + 4; // +4 for separator
			if (budgetChars !== undefined && usedChars + cost > budgetChars) continue;
			selected.push(d);
			usedChars += cost;
		}

		if (selected.length === 0) return this.base;

		// Re-sort chronologically: workspace first, then organ, then global.
		// Within the same layer, higher weight first.
		const layerOrder: Directive["layer"][] = ["workspace", "organ", "global"];
		selected.sort((a, b) => {
			const li = layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer);
			if (li !== 0) return li;
			return b.weight - a.weight;
		});

		const body = selected.map((d) => d.content).join("\n\n");
		return `${this.base}\n\n## Tool Guidance\n\n${body}`;
	}
}

// ---------------------------------------------------------------------------
// Backward-compat function (used by tests that import assembleSystemPrompt)
// ---------------------------------------------------------------------------

/**
 * Stateless helper for simple cases: base + organ strings, no budget, no workspace.
 * Use DirectiveContextAssembler for the full feature set.
 */
export function assembleSystemPrompt(base: string, organs: readonly Organ[]): string {
	const asm = new DirectiveContextAssembler(base);
	asm.registerOrgans(organs);
	return asm.build();
}
