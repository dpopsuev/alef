/**
 * ECS World — entity-component-system store, ported from tangle/world.
 *
 * Entities are just IDs. Components are typed data bags attached to entities.
 * Edges are typed directed relationships between entities.
 *
 * Used by the Supervisor to track all managed processes as entities
 * with components (Color, Schema, Process, Health, etc.).
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type EntityID = number;
export type ComponentType = string;

export interface Component {
	componentType: ComponentType;
}

export type DiffKind = "attached" | "detached" | "updated";
export type DiffHook = (
	id: EntityID,
	ct: ComponentType,
	kind: DiffKind,
	oldVal: Component | undefined,
	newVal: Component | undefined,
) => void;

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

export type Relation = "supervises" | "assigned_to" | "communicates_with" | "member_of" | "flows_to";
export type Direction = "outbound" | "inbound" | "both";

export interface Edge {
	from: EntityID;
	relation: Relation;
	to: EntityID;
}

/** Relations constrained to be acyclic (DAG) */
const DAG_RELATIONS = new Set<Relation>(["supervises"]);

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export class World {
	private nextId: EntityID = 0;
	private components = new Map<EntityID, Map<ComponentType, Component>>();
	private alive = new Set<EntityID>();
	private edges: Edge[] = [];
	private diffHooks: DiffHook[] = [];

	/** Register a hook called on attach/detach/update */
	onDiff(hook: DiffHook): void {
		this.diffHooks.push(hook);
	}

	/** Create a new entity (just an ID) */
	spawn(): EntityID {
		this.nextId++;
		const id = this.nextId;
		this.alive.add(id);
		this.components.set(id, new Map());
		return id;
	}

	/** Remove an entity and all its components and edges */
	despawn(id: EntityID): void {
		this.components.delete(id);
		this.alive.delete(id);
		this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
	}

	/** Check if entity exists */
	isAlive(id: EntityID): boolean {
		return this.alive.has(id);
	}

	/** Number of living entities */
	count(): number {
		return this.alive.size;
	}

	/** All living entity IDs */
	all(): EntityID[] {
		return [...this.alive];
	}

	// =====================================================================
	// Components
	// =====================================================================

	/** Attach a component to an entity. Replaces if already present. */
	attach(id: EntityID, component: Component): void {
		const bag = this.components.get(id);
		if (!bag) throw new Error(`World: attach on dead entity ${id}`);

		const ct = component.componentType;
		const old = bag.get(ct);
		const kind: DiffKind = old ? "updated" : "attached";
		bag.set(ct, component);

		for (const hook of this.diffHooks) {
			hook(id, ct, kind, old, component);
		}
	}

	/** Get a component by type. Returns undefined if not present. */
	get(id: EntityID, ct: ComponentType): Component | undefined {
		return this.components.get(id)?.get(ct);
	}

	/** Check if entity has a component type */
	has(id: EntityID, ct: ComponentType): boolean {
		return this.components.get(id)?.has(ct) ?? false;
	}

	/** Remove a component from an entity */
	detach(id: EntityID, ct: ComponentType): void {
		const bag = this.components.get(id);
		if (!bag) return;
		const old = bag.get(ct);
		if (!old) return;
		bag.delete(ct);

		for (const hook of this.diffHooks) {
			hook(id, ct, "detached", old, undefined);
		}
	}

	/** Find all entities that have a specific component type */
	query(ct: ComponentType): EntityID[] {
		const result: EntityID[] = [];
		for (const [id, bag] of this.components) {
			if (bag.has(ct)) result.push(id);
		}
		return result;
	}

	// =====================================================================
	// Edges
	// =====================================================================

	/** Create a typed directed edge. DAG-constrained relations reject cycles. */
	link(from: EntityID, relation: Relation, to: EntityID): void {
		if (from === to) throw new Error("World: self-loop not allowed");

		// Dedup
		if (this.edges.some((e) => e.from === from && e.relation === relation && e.to === to)) {
			throw new Error(`World: duplicate edge ${from} -[${relation}]-> ${to}`);
		}

		// DAG cycle check for constrained relations
		if (DAG_RELATIONS.has(relation) && this.wouldCreateCycle(from, relation, to)) {
			throw new Error(`World: cycle detected for DAG relation "${relation}"`);
		}

		this.edges.push({ from, relation, to });
	}

	/** Remove an edge */
	unlink(from: EntityID, relation: Relation, to: EntityID): void {
		const idx = this.edges.findIndex((e) => e.from === from && e.relation === relation && e.to === to);
		if (idx === -1) throw new Error(`World: edge not found ${from} -[${relation}]-> ${to}`);
		this.edges.splice(idx, 1);
	}

	/** Find connected entities by relation and direction */
	neighbors(id: EntityID, relation: Relation, direction: Direction = "outbound"): EntityID[] {
		const result: EntityID[] = [];
		for (const e of this.edges) {
			if (e.relation !== relation) continue;
			if ((direction === "outbound" || direction === "both") && e.from === id) result.push(e.to);
			if ((direction === "inbound" || direction === "both") && e.to === id) result.push(e.from);
		}
		return result;
	}

	/** All edges connected to an entity */
	edgesOf(id: EntityID): Edge[] {
		return this.edges.filter((e) => e.from === id || e.to === id);
	}

	/** Total edge count */
	edgeCount(): number {
		return this.edges.length;
	}

	// =====================================================================
	// DAG cycle detection (BFS from `to` following outbound edges)
	// =====================================================================

	private wouldCreateCycle(from: EntityID, relation: Relation, to: EntityID): boolean {
		// If adding from→to, check if `to` can already reach `from`
		const visited = new Set<EntityID>();
		const queue = [to];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (current === from) return true;
			if (visited.has(current)) continue;
			visited.add(current);
			for (const e of this.edges) {
				if (e.from === current && e.relation === relation) {
					queue.push(e.to);
				}
			}
		}
		return false;
	}
}
