/**
 * Agent Catalog Registry — searchable arsenal of agent schemas.
 *
 * The GenSec (and permitted control-plane agents) can:
 *   - Register agent schemas with labels, descriptions, and capabilities
 *   - Search by role, labels, capabilities, or free text
 *   - Browse the full catalog
 *
 * The catalog is backed by the ECS World. Each schema is an entity
 * with CatalogEntry and Labels components.
 */

import type { AgentSchema } from "./gensec.js";
import type { Component, ComponentType, EntityID } from "./world.js";
import { World } from "./world.js";

// ---------------------------------------------------------------------------
// Component types
// ---------------------------------------------------------------------------

const CATALOG_ENTRY_TYPE: ComponentType = "catalog_entry";
const LABELS_TYPE: ComponentType = "labels";
const CAPABILITIES_TYPE: ComponentType = "capabilities";

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export interface CatalogEntry extends Component {
	componentType: typeof CATALOG_ENTRY_TYPE;
	schema: AgentSchema;
	description: string;
	version: string;
	createdAt: number;
	updatedAt: number;
}

export interface Labels extends Component {
	componentType: typeof LABELS_TYPE;
	values: string[];
}

export interface Capabilities extends Component {
	componentType: typeof CAPABILITIES_TYPE;
	/** What this agent can do: "code_review", "web_search", "refactoring", etc. */
	values: string[];
}

// ---------------------------------------------------------------------------
// Search filters
// ---------------------------------------------------------------------------

export interface CatalogSearchFilter {
	/** Filter by role (exact match) */
	role?: string;
	/** Filter by labels (all must match) */
	labels?: string[];
	/** Filter by capabilities (any must match) */
	capabilities?: string[];
	/** Free text search across name, description, role */
	text?: string;
}

// ---------------------------------------------------------------------------
// Search result
// ---------------------------------------------------------------------------

export interface CatalogSearchResult {
	entityId: EntityID;
	schema: AgentSchema;
	description: string;
	labels: string[];
	capabilities: string[];
	version: string;
	/** Relevance score (0-1) for text searches */
	score: number;
}

// ---------------------------------------------------------------------------
// Agent Catalog
// ---------------------------------------------------------------------------

export class AgentCatalog {
	private world = new World();
	private nameIndex = new Map<string, EntityID>();

	/** Register a schema in the catalog */
	register(
		schema: AgentSchema,
		options: {
			description: string;
			labels?: string[];
			capabilities?: string[];
			version?: string;
		},
	): EntityID {
		// Check for existing entry with same name
		const existing = this.nameIndex.get(schema.name);
		if (existing !== undefined && this.world.isAlive(existing)) {
			// Update in place
			return this.update(existing, schema, options);
		}

		const id = this.world.spawn();
		this.nameIndex.set(schema.name, id);

		const now = Date.now();
		this.world.attach(id, {
			componentType: CATALOG_ENTRY_TYPE,
			schema,
			description: options.description,
			version: options.version ?? "1.0.0",
			createdAt: now,
			updatedAt: now,
		} as CatalogEntry);

		if (options.labels?.length) {
			this.world.attach(id, {
				componentType: LABELS_TYPE,
				values: options.labels,
			} as Labels);
		}

		if (options.capabilities?.length) {
			this.world.attach(id, {
				componentType: CAPABILITIES_TYPE,
				values: options.capabilities,
			} as Capabilities);
		}

		return id;
	}

	/** Update an existing catalog entry */
	private update(
		id: EntityID,
		schema: AgentSchema,
		options: {
			description: string;
			labels?: string[];
			capabilities?: string[];
			version?: string;
		},
	): EntityID {
		const existing = this.world.get(id, CATALOG_ENTRY_TYPE) as CatalogEntry | undefined;
		this.world.attach(id, {
			componentType: CATALOG_ENTRY_TYPE,
			schema,
			description: options.description,
			version: options.version ?? existing?.version ?? "1.0.0",
			createdAt: existing?.createdAt ?? Date.now(),
			updatedAt: Date.now(),
		} as CatalogEntry);

		if (options.labels?.length) {
			this.world.attach(id, { componentType: LABELS_TYPE, values: options.labels } as Labels);
		}

		if (options.capabilities?.length) {
			this.world.attach(id, { componentType: CAPABILITIES_TYPE, values: options.capabilities } as Capabilities);
		}

		return id;
	}

	/** Remove a schema from the catalog */
	unregister(name: string): void {
		const id = this.nameIndex.get(name);
		if (id !== undefined) {
			this.world.despawn(id);
			this.nameIndex.delete(name);
		}
	}

	/** Get a schema by name */
	get(name: string): CatalogSearchResult | undefined {
		const id = this.nameIndex.get(name);
		if (id === undefined || !this.world.isAlive(id)) return undefined;
		return this.toResult(id, 1.0);
	}

	/** List all registered schemas */
	list(): CatalogSearchResult[] {
		return this.world
			.query(CATALOG_ENTRY_TYPE)
			.map((id) => this.toResult(id, 1.0))
			.filter((r): r is CatalogSearchResult => r !== undefined)
			.sort((a, b) => a.schema.name.localeCompare(b.schema.name));
	}

	/** Search the catalog with filters */
	search(filter: CatalogSearchFilter): CatalogSearchResult[] {
		const allIds = this.world.query(CATALOG_ENTRY_TYPE);
		const results: CatalogSearchResult[] = [];

		for (const id of allIds) {
			const entry = this.world.get(id, CATALOG_ENTRY_TYPE) as CatalogEntry | undefined;
			if (!entry) continue;

			const labels = (this.world.get(id, LABELS_TYPE) as Labels | undefined)?.values ?? [];
			const capabilities = (this.world.get(id, CAPABILITIES_TYPE) as Capabilities | undefined)?.values ?? [];

			// Role filter (exact)
			if (filter.role && entry.schema.role !== filter.role) continue;

			// Labels filter (all must match)
			if (filter.labels?.length) {
				const hasAll = filter.labels.every((l) => labels.includes(l));
				if (!hasAll) continue;
			}

			// Capabilities filter (any must match)
			if (filter.capabilities?.length) {
				const hasAny = filter.capabilities.some((c) => capabilities.includes(c));
				if (!hasAny) continue;
			}

			// Text search (fuzzy across name, description, role)
			let score = 1.0;
			if (filter.text) {
				const lower = filter.text.toLowerCase();
				const searchable = [entry.schema.name, entry.description, entry.schema.role, ...labels, ...capabilities]
					.join(" ")
					.toLowerCase();

				if (!searchable.includes(lower)) continue;

				// Score: exact name match > description > labels
				if (entry.schema.name.toLowerCase() === lower) score = 1.0;
				else if (entry.schema.name.toLowerCase().includes(lower)) score = 0.9;
				else if (entry.description.toLowerCase().includes(lower)) score = 0.7;
				else score = 0.5;
			}

			results.push({
				entityId: id,
				schema: entry.schema,
				description: entry.description,
				labels,
				capabilities,
				version: entry.version,
				score,
			});
		}

		return results.sort((a, b) => b.score - a.score);
	}

	/** Number of registered schemas */
	get size(): number {
		return this.world.query(CATALOG_ENTRY_TYPE).length;
	}

	/** Get the underlying ECS World (for advanced queries) */
	getWorld(): World {
		return this.world;
	}

	// =====================================================================
	// Internal
	// =====================================================================

	private toResult(id: EntityID, score: number): CatalogSearchResult | undefined {
		const entry = this.world.get(id, CATALOG_ENTRY_TYPE) as CatalogEntry | undefined;
		if (!entry) return undefined;

		const labels = (this.world.get(id, LABELS_TYPE) as Labels | undefined)?.values ?? [];
		const capabilities = (this.world.get(id, CAPABILITIES_TYPE) as Capabilities | undefined)?.values ?? [];

		return {
			entityId: id,
			schema: entry.schema,
			description: entry.description,
			labels,
			capabilities,
			version: entry.version,
			score,
		};
	}
}
