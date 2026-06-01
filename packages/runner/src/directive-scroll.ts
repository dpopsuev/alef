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

export interface DirectiveScrollState {
	blocks: Array<Omit<Directive, "content"> & { content: string }>;
}

export type DirectiveRenderer = (blocks: ReadonlyArray<ResolvedDirective>) => string;
export type DirectiveBudgetStrategy = (
	blocks: ReadonlyArray<ResolvedDirective>,
	budget: number,
) => ReadonlyArray<ResolvedDirective>;
export type DirectiveComparator = (a: Directive, b: Directive) => number;

const defaultRenderer: DirectiveRenderer = (blocks) => blocks.map((b) => b.content).join("\n\n");

const defaultDirectiveBudgetStrategy: DirectiveBudgetStrategy = (blocks, budget) => {
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

export class DirectiveScroll {
	private readonly _blocks = new Map<string, Directive>();

	renderer: DirectiveRenderer = defaultRenderer;
	budgetStrategy: DirectiveBudgetStrategy = defaultDirectiveBudgetStrategy;
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

	clone(): DirectiveScroll {
		const s = new DirectiveScroll();
		s.renderer = this.renderer;
		s.budgetStrategy = this.budgetStrategy;
		s.comparator = this.comparator;
		for (const b of this._blocks.values()) s._blocks.set(b.id, { ...b });
		return s;
	}

	merge(other: DirectiveScroll, strategy: "last-wins" | "keep-existing" = "last-wins"): DirectiveScroll {
		const s = this.clone();
		for (const b of other._blocks.values()) {
			if (strategy === "keep-existing" && s._blocks.has(b.id)) continue;
			s._blocks.set(b.id, { ...b });
		}
		return s;
	}

	subset(predicate: (block: Directive) => boolean): DirectiveScroll {
		const s = new DirectiveScroll();
		s.renderer = this.renderer;
		s.budgetStrategy = this.budgetStrategy;
		s.comparator = this.comparator;
		for (const b of this._blocks.values()) {
			if (predicate(b)) s._blocks.set(b.id, { ...b });
		}
		return s;
	}

	without(...ids: string[]): DirectiveScroll {
		const drop = new Set(ids);
		return this.subset((b) => !drop.has(b.id));
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

	toJSON(): DirectiveScrollState {
		return {
			blocks: [...this._blocks.values()].map((b) => ({
				...b,
				content: typeof b.content === "function" ? b.content() : b.content,
			})),
		};
	}

	static fromJSON(state: DirectiveScrollState): DirectiveScroll {
		const s = new DirectiveScroll();
		for (const b of state.blocks) s._blocks.set(b.id, { ...b });
		return s;
	}
}
