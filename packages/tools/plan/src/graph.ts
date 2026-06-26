import { readFileSync, writeFileSync } from "node:fs";
import type { PlanUpdateEvent } from "@dpopsuev/alef-kernel/adapter";

export type Phase =
	| "intention"
	| "inception"
	| "contraction"
	| "fixation"
	| "expansion"
	| "reduction"
	| "consolidation"
	| "implementation"
	| "assessment"
	| "refinement"
	| "introspection"
	| "closed";

const PHASE_ORDER: Phase[] = [
	"intention",
	"inception",
	"contraction",
	"fixation",
	"expansion",
	"reduction",
	"consolidation",
	"implementation",
	"assessment",
	"refinement",
	"introspection",
	"closed",
];

const BLOCK_MAP: Record<Phase, string> = {
	intention: "ideation",
	inception: "ideation",
	contraction: "ideation",
	fixation: "ideation",
	expansion: "planning",
	reduction: "planning",
	consolidation: "planning",
	implementation: "execution",
	assessment: "execution",
	refinement: "execution",
	introspection: "introspection",
	closed: "closed",
};

export interface PlanNode {
	id: string;
	parent: string | null;
	label: string;
	status: "pending" | "active" | "done" | "pruned" | "deferred";
	depth: number;
	result?: string;
	feedback?: string;
	/** Delegation tracking - which subagent is working on this node */
	delegatedTo?: {
		/** Subagent profile or child name */
		agentProfile: string;
		/** When delegation started */
		delegatedAt: number;
		/** Correlation ID for tracking */
		correlationId?: string;
	};
	/** If this plan is scoped, the original root node ID in parent plan */
	scopeRoot?: string;
}

export interface PlanData {
	id: string;
	phase: Phase;
	intention: string;
	inception: { current: string; desired: string; delta: string } | null;
	exclusions: string[];
	endState: string | null;
	nodes: PlanNode[];
	checkpoints: Record<string, { status: string; result?: string }>;
	aar: string | null;
	createdAt: number;
	updatedAt: number;
	/** Parent plan linkage for scoped plans */
	parentPlanId?: string;
	/** For scoped plans, which node is the root */
	rootNodeId?: string;
}

export class PlanGraph {
	private data: PlanData;
	private diskPath: string | null;
	private nodeIndex = new Map<string, PlanNode>();
	private childIndex = new Map<string, string[]>();
	private nodeSeq = 0;

	constructor(id: string, intention: string, diskPath: string | null = null) {
		this.data = {
			id,
			phase: "intention",
			intention,
			inception: null,
			exclusions: [],
			endState: null,
			nodes: [],
			checkpoints: {},
			aar: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.diskPath = diskPath;
		this.flush();
	}

	static load(diskPath: string): PlanGraph | null {
		try {
			const raw = readFileSync(diskPath, "utf-8");
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- plan JSON written by flush()
			const data = JSON.parse(raw) as PlanData;
			const graph = new PlanGraph(data.id, data.intention, diskPath);
			graph.data = data;
			graph.rebuildIndex();
			return graph;
		} catch {
			return null;
		}
	}

	/**
	 * Create a scoped plan view for a subagent.
	 * The scoped plan starts in 'implementation' phase with the given subgraph.
	 */
	static createScoped(
		parentPlanId: string,
		rootNodeId: string,
		nodes: PlanNode[],
		intention: string,
		inception: { current: string; desired: string; delta: string } | null,
		diskPath: string | null = null,
	): PlanGraph {
		const scopedId = `${parentPlanId}/scoped-${rootNodeId}`;
		const plan = new PlanGraph(scopedId, intention, diskPath);

		// Set parent linkage
		plan.data.parentPlanId = parentPlanId;
		plan.data.rootNodeId = rootNodeId;
		plan.data.inception = inception;

		// Keep original node IDs - they're globally unique
		plan.data.nodes = nodes.map((n) => ({
			...n,
			scopeRoot: n.id === rootNodeId ? rootNodeId : undefined,
		}));

		// Start in implementation phase (scoped plans are work-focused)
		plan.data.phase = "implementation";

		plan.rebuildIndex();
		plan.flush();

		return plan;
	}

	private rebuildIndex(): void {
		this.nodeIndex.clear();
		this.childIndex.clear();
		for (const node of this.data.nodes) {
			this.nodeIndex.set(node.id, node);
			const parentKey = node.parent ?? "__root__";
			const children = this.childIndex.get(parentKey) ?? [];
			children.push(node.id);
			this.childIndex.set(parentKey, children);
			const seq = Number.parseInt(node.id.replace("n", ""), 10);
			if (seq >= this.nodeSeq) this.nodeSeq = seq + 1;
		}
	}

	private touch(): void {
		this.data.updatedAt = Date.now();
		this.flush();
	}

	private flush(): void {
		if (!this.diskPath) return;
		writeFileSync(this.diskPath, JSON.stringify(this.data, null, 2), "utf-8");
	}

	get id(): string {
		return this.data.id;
	}
	get phase(): Phase {
		return this.data.phase;
	}
	get block(): string {
		return BLOCK_MAP[this.data.phase];
	}

	advanceTo(target: Phase): string | null {
		const currentIdx = PHASE_ORDER.indexOf(this.data.phase);
		const targetIdx = PHASE_ORDER.indexOf(target);
		if (targetIdx < 0) return `unknown phase: ${target}`;
		if (targetIdx < currentIdx) return `cannot go back from ${this.data.phase} to ${target}`;
		this.data.phase = target;
		this.touch();
		return null;
	}

	setInception(current: string, desired: string, delta: string): void {
		this.data.inception = { current, desired, delta };
		this.advanceTo("inception");
	}

	addExclusion(item: string): void {
		this.data.exclusions.push(item);
		if (this.data.phase === "inception") this.advanceTo("contraction");
	}

	setEndState(endState: string): void {
		this.data.endState = endState;
		this.advanceTo("fixation");
	}

	private slugify(label: string): string {
		let slug = label
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.trim()
			.replace(/\s+/g, "-")
			.slice(0, 60);
		if (this.nodeIndex.has(slug)) {
			slug = `${slug}-${this.nodeSeq++}`;
		}
		return slug;
	}

	addNode(label: string, parent: string | null = null): PlanNode {
		const words = label.trim().split(/\s+/);
		if (words.length < 3) throw new Error(`Node label too short (${words.length} words, min 3): "${label}"`);
		if (words.length > 8) throw new Error(`Node label too long (${words.length} words, max 8): "${label}"`);
		if (parent && !this.nodeIndex.has(parent)) {
			throw new Error(`parent node ${parent} not found`);
		}
		const id = this.slugify(label);
		const depth = parent ? (this.nodeIndex.get(parent)?.depth ?? 0) + 1 : 0;
		const node: PlanNode = { id, parent, label, status: "pending", depth };
		this.data.nodes.push(node);
		this.nodeIndex.set(id, node);
		const parentKey = parent ?? "__root__";
		const children = this.childIndex.get(parentKey) ?? [];
		children.push(id);
		this.childIndex.set(parentKey, children);
		if (this.data.phase === "fixation") this.advanceTo("expansion");
		this.touch();
		return node;
	}

	pruneNode(id: string): boolean {
		const node = this.nodeIndex.get(id);
		if (!node) return false;
		node.status = "pruned";
		if (this.data.phase === "expansion") this.advanceTo("reduction");
		this.touch();
		return true;
	}

	deferNode(id: string): boolean {
		const node = this.nodeIndex.get(id);
		if (!node) return false;
		node.status = "deferred";
		this.touch();
		return true;
	}

	checkpoint(id: string): boolean {
		const node = this.nodeIndex.get(id);
		if (!node) return false;
		node.status = "active";
		this.data.checkpoints[id] = { status: "active" };
		if (this.data.phase === "consolidation" || this.data.phase === "reduction") {
			this.advanceTo("implementation");
		}
		this.touch();
		return true;
	}

	assess(id: string, result: string): boolean {
		const node = this.nodeIndex.get(id);
		if (!node) return false;
		node.result = result;
		this.data.checkpoints[id] = { status: "assessed", result };
		if (this.data.phase === "implementation") this.advanceTo("assessment");
		this.touch();
		return true;
	}

	refine(id: string, feedback: string): boolean {
		const node = this.nodeIndex.get(id);
		if (!node) return false;
		node.feedback = feedback;
		node.status = "pending";
		this.data.checkpoints[id] = { status: "refined" };
		if (this.data.phase === "assessment") this.advanceTo("refinement");
		this.touch();
		return true;
	}

	completeNode(id: string): boolean {
		const node = this.nodeIndex.get(id);
		if (!node) return false;
		node.status = "done";
		this.data.checkpoints[id] = { status: "done" };
		this.touch();
		return true;
	}

	setAAR(aar: string): void {
		this.data.aar = aar;
		this.advanceTo("introspection");
	}

	close(): void {
		this.advanceTo("closed");
	}

	/**
	 * Extract all nodes in the subtree rooted at nodeId.
	 * Returns nodes in depth-first order: [root, ...descendants].
	 * Returns empty array if node doesn't exist.
	 */
	extractSubgraph(nodeId: string): PlanNode[] {
		const root = this.nodeIndex.get(nodeId);
		if (!root) return [];

		const nodes: PlanNode[] = [];
		const traverse = (id: string) => {
			const node = this.nodeIndex.get(id);
			if (!node) return;

			// Clone to avoid mutations
			nodes.push({ ...node });

			// Traverse children
			const children = this.childIndex.get(id) ?? [];
			for (const childId of children) {
				traverse(childId);
			}
		};

		traverse(nodeId);
		return nodes;
	}

	/**
	 * Check if this plan is a scoped child plan.
	 */
	isScoped(): boolean {
		return this.data.parentPlanId !== undefined;
	}

	/**
	 * Get the parent plan ID if this is a scoped plan.
	 */
	getParentPlanId(): string | null {
		return this.data.parentPlanId ?? null;
	}

	/**
	 * Apply an update from a child scoped plan.
	 * Updates the corresponding node in this (parent) plan.
	 */
	applyChildUpdate(update: PlanUpdateEvent): boolean {
		const node = this.nodeIndex.get(update.nodeId);
		if (!node) {
			return false;
		}

		switch (update.action) {
			case "checkpoint":
				node.status = "active";
				this.data.checkpoints[update.nodeId] = { status: "active" };
				break;

			case "complete":
				node.status = "done";
				this.data.checkpoints[update.nodeId] = { status: "done" };
				break;

			case "expand": {
				// Child added new nodes under their scope
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- PlanUpdateEvent payload shape per action
				const { label, parentId } = update.payload as { label: string; parentId: string };
				this.addNode(label, parentId);
				break;
			}

			case "assess": {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- PlanUpdateEvent payload shape per action
				const { result } = update.payload as { result: string };
				node.result = result;
				this.data.checkpoints[update.nodeId] = { status: "assessed", result };
				break;
			}

			case "refine": {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- PlanUpdateEvent payload shape per action
				const { feedback } = update.payload as { feedback: string };
				node.feedback = feedback;
				node.status = "pending";
				this.data.checkpoints[update.nodeId] = { status: "refined" };
				break;
			}

			default:
				return false;
		}

		this.touch();
		return true;
	}

	getNode(id: string): PlanNode | undefined {
		return this.nodeIndex.get(id);
	}

	children(parentId: string | null): PlanNode[] {
		const key = parentId ?? "__root__";
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- filter(Boolean) removes undefined entries
		return (this.childIndex.get(key) ?? []).map((id) => this.nodeIndex.get(id)).filter(Boolean) as PlanNode[];
	}

	activeNodes(): PlanNode[] {
		return this.data.nodes.filter((n) => n.status === "pending" || n.status === "active");
	}

	stats(): { total: number; done: number; pending: number; pruned: number; active: number } {
		let done = 0,
			pending = 0,
			pruned = 0,
			active = 0;
		for (const n of this.data.nodes) {
			if (n.status === "done") done++;
			else if (n.status === "pruned") pruned++;
			else if (n.status === "active") active++;
			else if (n.status === "pending") pending++;
		}
		return { total: this.data.nodes.length, done, pending, pruned, active };
	}

	private static nodeGlyph(status: PlanNode["status"]): string {
		switch (status) {
			case "done":
				return "■";
			case "active":
				return "●";
			case "pruned":
				return "×";
			case "deferred":
				return "◇";
			default:
				return "○";
		}
	}

	renderTree(): string {
		const lines: string[] = [];
		const renderNode = (node: PlanNode, prefix: string, isLast: boolean): void => {
			const status = PlanGraph.nodeGlyph(node.status);
			const branch = isLast ? "└── " : "├── ";
			lines.push(`${prefix}${branch}${status} ${node.id}: ${node.label}`);
			const kids = this.children(node.id);
			for (let i = 0; i < kids.length; i++) {
				renderNode(kids[i], `${prefix}${isLast ? "    " : "│   "}`, i === kids.length - 1);
			}
		};
		const roots = this.children(null);
		for (let i = 0; i < roots.length; i++) {
			renderNode(roots[i], "", i === roots.length - 1);
		}
		return lines.join("\n");
	}

	private countDescendants(nodeId: string): { total: number; done: number; active: number } {
		let total = 0;
		let done = 0;
		let active = 0;
		const count = (id: string) => {
			const kids = this.children(id);
			for (const k of kids) {
				total++;
				if (k.status === "done") done++;
				if (k.status === "active") active++;
				count(k.id);
			}
		};
		count(nodeId);
		return { total, done, active };
	}

	private ancestorChain(nodeId: string): string[] {
		const chain: string[] = [];
		let current = this.nodeIndex.get(nodeId);
		while (current?.parent) {
			chain.unshift(current.parent);
			current = this.nodeIndex.get(current.parent);
		}
		return chain;
	}

	renderFocusedTree(): string {
		const activeNode = this.data.nodes.find((n) => n.status === "active");
		if (!activeNode) return this.renderTree();

		const ancestorIds = new Set(this.ancestorChain(activeNode.id));
		ancestorIds.add(activeNode.id);

		const sg = (n: PlanNode) => PlanGraph.nodeGlyph(n.status);

		const agentSuffix = (n: PlanNode) => (n.delegatedTo ? `  @${n.delegatedTo.agentProfile}` : "");

		const lines: string[] = [];

		const render = (node: PlanNode, prefix: string, isLast: boolean): void => {
			const branch = isLast ? "└── " : "├── ";
			const glyph = sg(node);
			const kids = this.children(node.id);
			const onPath = ancestorIds.has(node.id);
			const isActive = node.id === activeNode.id;

			if (isActive) {
				const siblings = node.parent ? this.children(node.parent) : this.children(null);
				const idx = siblings.findIndex((s) => s.id === node.id);
				if (idx > 0) {
					const prev = siblings[idx - 1];
					lines.push(`${prefix}${branch}${sg(prev)} ${prev.label}${agentSuffix(prev)}`);
				}
				lines.push(`${prefix}${branch}${glyph} ${node.label}${agentSuffix(node)}  ◄`);
				for (const kid of kids) {
					render(kid, `${prefix}${isLast ? "    " : "│   "}`, kid === kids[kids.length - 1]);
				}
				if (idx < siblings.length - 1) {
					const next = siblings[idx + 1];
					lines.push(`${prefix}${branch}${sg(next)} ${next.label}${agentSuffix(next)}`);
				}
				return;
			}

			if (onPath) {
				lines.push(`${prefix}${branch}${glyph} ${node.label}${agentSuffix(node)}`);
				for (const kid of kids) {
					render(kid, `${prefix}${isLast ? "    " : "│   "}`, kid === kids[kids.length - 1]);
				}
				return;
			}

			const desc = this.countDescendants(node.id);
			const hint = desc.total > 0 ? ` [${desc.done}/${desc.total}]` : "";
			lines.push(`${prefix}${branch}${glyph} ${node.label}${hint}${agentSuffix(node)}`);
		};

		const roots = this.children(null);
		for (let i = 0; i < roots.length; i++) {
			render(roots[i], "", i === roots.length - 1);
		}
		return lines.join("\n");
	}

	renderSummary(): string {
		const s = this.stats();
		const parts = [`Plan: ${this.data.id} [${this.data.phase}/${this.block}]`, `Intent: ${this.data.intention}`];
		if (this.data.inception) {
			parts.push(`Current: ${this.data.inception.current}`);
			parts.push(`Desired: ${this.data.inception.desired}`);
			parts.push(`Delta: ${this.data.inception.delta}`);
		}
		if (this.data.exclusions.length > 0) parts.push(`Exclusions: ${this.data.exclusions.join(", ")}`);
		if (this.data.endState) parts.push(`End state: ${this.data.endState}`);
		if (s.total > 0) {
			parts.push(`Nodes: ${s.total} (${s.done} done, ${s.active} active, ${s.pending} pending, ${s.pruned} pruned)`);
			const tree = this.renderTree();
			if (tree) parts.push("", tree);
		}
		if (this.data.aar) parts.push(`\nAAR: ${this.data.aar}`);
		return parts.join("\n");
	}

	toJSON(): PlanData {
		return structuredClone(this.data);
	}
}
