export interface Directive {
	id: string;
	priority: number;
	content: string | (() => string);
	enabled: boolean;
	tags?: string[];
	maxChars?: number;
	meta?: Record<string, unknown>;
}

export interface ResolvedDirective extends Omit<Directive, "content"> {
	content: string;
}

export interface DirectivesState {
	blocks: Array<Omit<Directive, "content"> & { content: string }>;
}

export type DirectiveRenderer = (blocks: ReadonlyArray<ResolvedDirective>) => string;
export type DirectiveBudgetStrategy = (
	blocks: ReadonlyArray<ResolvedDirective>,
	budget: number,
) => ReadonlyArray<ResolvedDirective>;
export type DirectiveComparator = (a: Directive, b: Directive) => number;

const defaultRenderer: DirectiveRenderer = (blocks) => blocks.map((b) => b.content).join("\n\n");

const defaultBudgetStrategy: DirectiveBudgetStrategy = (blocks, budget) => {
	const sorted = [...blocks].sort((a, b) => a.priority - b.priority);
	const selected: ResolvedDirective[] = [];
	let used = 0;
	for (const b of sorted) {
		const cost = b.content.length;
		if (used + cost > budget) continue;
		selected.push(b);
		used += cost;
	}
	return selected;
};

const defaultComparator: DirectiveComparator = (a, b) => a.priority - b.priority;

export class Directives {
	private readonly _blocks = new Map<string, Directive>();

	renderer: DirectiveRenderer = defaultRenderer;
	budgetStrategy: DirectiveBudgetStrategy = defaultBudgetStrategy;
	comparator: DirectiveComparator = defaultComparator;

	register(block: Directive): this {
		this._blocks.set(block.id, { ...block });
		return this;
	}

	unregister(id: string): this {
		this._blocks.delete(id);
		return this;
	}

	enable(id: string): this {
		const b = this._blocks.get(id);
		if (b) this._blocks.set(id, { ...b, enabled: true });
		return this;
	}

	disable(id: string): this {
		const b = this._blocks.get(id);
		if (b) this._blocks.set(id, { ...b, enabled: false });
		return this;
	}

	toggle(id: string): this {
		const b = this._blocks.get(id);
		if (b) this._blocks.set(id, { ...b, enabled: !b.enabled });
		return this;
	}

	replace(id: string, content: string | (() => string)): this {
		const b = this._blocks.get(id);
		if (b) this._blocks.set(id, { ...b, content });
		return this;
	}

	setPriority(id: string, priority: number): this {
		const b = this._blocks.get(id);
		if (b) this._blocks.set(id, { ...b, priority });
		return this;
	}

	setMeta(id: string, key: string, value: unknown): this {
		const b = this._blocks.get(id);
		if (b) this._blocks.set(id, { ...b, meta: { ...b.meta, [key]: value } });
		return this;
	}

	tag(id: string, ...tags: string[]): this {
		const b = this._blocks.get(id);
		if (b) {
			const existing = new Set(b.tags ?? []);
			for (const t of tags) existing.add(t);
			this._blocks.set(id, { ...b, tags: [...existing] });
		}
		return this;
	}

	untag(id: string, ...tags: string[]): this {
		const b = this._blocks.get(id);
		if (b?.tags) {
			const drop = new Set(tags);
			this._blocks.set(id, { ...b, tags: b.tags.filter((t) => !drop.has(t)) });
		}
		return this;
	}

	has(id: string): boolean {
		return this._blocks.has(id);
	}

	get(id: string): Readonly<Directive> | undefined {
		return this._blocks.get(id);
	}

	list(filter?: {
		enabled?: boolean;
		tags?: string[];
		anyTag?: string[];
		minPriority?: number;
		maxPriority?: number;
	}): ReadonlyArray<Directive> {
		let blocks = [...this._blocks.values()];
		if (filter) {
			if (filter.enabled !== undefined) blocks = blocks.filter((b) => b.enabled === filter.enabled);
			if (filter.tags?.length) {
				const required = filter.tags;
				blocks = blocks.filter((b) => required.every((t) => b.tags?.includes(t)));
			}
			if (filter.anyTag?.length) {
				const any = filter.anyTag;
				blocks = blocks.filter((b) => any.some((t) => b.tags?.includes(t)));
			}
			if (filter.minPriority !== undefined) {
				const min = filter.minPriority;
				blocks = blocks.filter((b) => b.priority >= min);
			}
			if (filter.maxPriority !== undefined) {
				const max = filter.maxPriority;
				blocks = blocks.filter((b) => b.priority <= max);
			}
		}
		return blocks.sort(this.comparator);
	}

	clone(): Directives {
		const d = new Directives();
		d.renderer = this.renderer;
		d.budgetStrategy = this.budgetStrategy;
		d.comparator = this.comparator;
		for (const b of this._blocks.values()) d._blocks.set(b.id, { ...b });
		return d;
	}

	merge(other: Directives, strategy: "last-wins" | "keep-existing" = "last-wins"): Directives {
		const d = this.clone();
		for (const b of other._blocks.values()) {
			if (strategy === "keep-existing" && d._blocks.has(b.id)) continue;
			d._blocks.set(b.id, { ...b });
		}
		return d;
	}

	subset(predicate: (block: Directive) => boolean): Directives {
		const d = new Directives();
		d.renderer = this.renderer;
		d.budgetStrategy = this.budgetStrategy;
		d.comparator = this.comparator;
		for (const b of this._blocks.values()) {
			if (predicate(b)) d._blocks.set(b.id, { ...b });
		}
		return d;
	}

	without(...ids: string[]): Directives {
		const drop = new Set(ids);
		return this.subset((b) => !drop.has(b.id));
	}

	append(id: string, content: string): this {
		const b = this._blocks.get(id);
		if (!b) return this;
		const existing = b.content;
		const combined =
			typeof existing === "function" ? () => `${existing()}\n\n${content}` : `${existing}\n\n${content}`;
		this._blocks.set(id, { ...b, content: combined });
		return this;
	}

	prepend(id: string, content: string): this {
		const b = this._blocks.get(id);
		if (!b) return this;
		const existing = b.content;
		const combined =
			typeof existing === "function" ? () => `${content}\n\n${existing()}` : `${content}\n\n${existing}`;
		this._blocks.set(id, { ...b, content: combined });
		return this;
	}

	resolve(): ReadonlyArray<ResolvedDirective> {
		return this.list({ enabled: true }).map((b) => ({
			...b,
			content: typeof b.content === "function" ? b.content() : b.content,
		}));
	}

	build(budgetChars?: number): string {
		const resolved = this.resolve();
		const selected = budgetChars !== undefined ? this.budgetStrategy(resolved, budgetChars) : resolved;
		const sorted = [...selected].sort(this.comparator);
		return this.renderer(sorted);
	}

	toJSON(): DirectivesState {
		return {
			blocks: [...this._blocks.values()].map((b) => ({
				...b,
				content: typeof b.content === "function" ? b.content() : b.content,
			})),
		};
	}

	static fromJSON(state: DirectivesState): Directives {
		const d = new Directives();
		for (const b of state.blocks) d._blocks.set(b.id, { ...b });
		return d;
	}
}

/**
 * XML renderer — wraps each directive block in a tag named by its id.
 *
 * Block id "no-emojis" → `<no-emojis>\ncontent\n</no-emojis>`
 *
 * Claude parses XML-tagged sections unambiguously regardless of block length.
 * Use this as the default renderer in createDefaultDirectives.
 */
export const xmlRenderer: DirectiveRenderer = (blocks) =>
	blocks.map((b) => `<${b.id}>\n${b.content}\n</${b.id}>`).join("\n\n");
