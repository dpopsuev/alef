export interface PromptBlock {
	id: string;
	priority: number;
	content: string | (() => string);
	enabled: boolean;
	tags?: string[];
	maxChars?: number;
	meta?: Record<string, unknown>;
}

export interface ResolvedBlock extends Omit<PromptBlock, "content"> {
	content: string;
}

export interface PromptScrollState {
	blocks: Array<Omit<PromptBlock, "content"> & { content: string }>;
}

export type BlockRenderer = (blocks: ReadonlyArray<ResolvedBlock>) => string;
export type BudgetStrategy = (blocks: ReadonlyArray<ResolvedBlock>, budget: number) => ReadonlyArray<ResolvedBlock>;
export type BlockComparator = (a: PromptBlock, b: PromptBlock) => number;

const defaultRenderer: BlockRenderer = (blocks) => blocks.map((b) => b.content).join("\n\n");

const defaultBudgetStrategy: BudgetStrategy = (blocks, budget) => {
	const sorted = [...blocks].sort((a, b) => a.priority - b.priority);
	const selected: ResolvedBlock[] = [];
	let used = 0;
	for (const b of sorted) {
		const cost = b.content.length;
		if (used + cost > budget) continue;
		selected.push(b);
		used += cost;
	}
	return selected;
};

const defaultComparator: BlockComparator = (a, b) => a.priority - b.priority;

export class PromptScroll {
	private readonly _blocks = new Map<string, PromptBlock>();

	renderer: BlockRenderer = defaultRenderer;
	budgetStrategy: BudgetStrategy = defaultBudgetStrategy;
	comparator: BlockComparator = defaultComparator;

	register(block: PromptBlock): this {
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

	get(id: string): Readonly<PromptBlock> | undefined {
		return this._blocks.get(id);
	}

	list(filter?: {
		enabled?: boolean;
		tags?: string[];
		anyTag?: string[];
		minPriority?: number;
		maxPriority?: number;
	}): ReadonlyArray<PromptBlock> {
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

	clone(): PromptScroll {
		const s = new PromptScroll();
		s.renderer = this.renderer;
		s.budgetStrategy = this.budgetStrategy;
		s.comparator = this.comparator;
		for (const b of this._blocks.values()) s._blocks.set(b.id, { ...b });
		return s;
	}

	merge(other: PromptScroll, strategy: "last-wins" | "keep-existing" = "last-wins"): PromptScroll {
		const s = this.clone();
		for (const b of other._blocks.values()) {
			if (strategy === "keep-existing" && s._blocks.has(b.id)) continue;
			s._blocks.set(b.id, { ...b });
		}
		return s;
	}

	subset(predicate: (block: PromptBlock) => boolean): PromptScroll {
		const s = new PromptScroll();
		s.renderer = this.renderer;
		s.budgetStrategy = this.budgetStrategy;
		s.comparator = this.comparator;
		for (const b of this._blocks.values()) {
			if (predicate(b)) s._blocks.set(b.id, { ...b });
		}
		return s;
	}

	without(...ids: string[]): PromptScroll {
		const drop = new Set(ids);
		return this.subset((b) => !drop.has(b.id));
	}

	resolve(): ReadonlyArray<ResolvedBlock> {
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

	toJSON(): PromptScrollState {
		return {
			blocks: [...this._blocks.values()].map((b) => ({
				...b,
				content: typeof b.content === "function" ? b.content() : b.content,
			})),
		};
	}

	static fromJSON(state: PromptScrollState): PromptScroll {
		const s = new PromptScroll();
		for (const b of state.blocks) s._blocks.set(b.id, { ...b });
		return s;
	}
}
