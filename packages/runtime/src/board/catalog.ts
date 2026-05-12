import type { AgentSchema } from "./gensec.js";
import type { Component, ComponentType, EntityID } from "./world.js";
import { World } from "./world.js";

const CATALOG_ENTRY_TYPE: ComponentType = "catalog_entry";
const LABELS_TYPE: ComponentType = "labels";
const CAPABILITIES_TYPE: ComponentType = "capabilities";

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
	values: string[];
}

export interface CatalogSearchFilter {
	role?: string;
	labels?: string[];
	capabilities?: string[];
	text?: string;
}

export interface CatalogSearchResult {
	entityId: EntityID;
	schema: AgentSchema;
	description: string;
	labels: string[];
	capabilities: string[];
	version: string;
	score: number;
}

export class AgentCatalog {
	private world = new World();
	private nameIndex = new Map<string, EntityID>();

	register(
		schema: AgentSchema,
		options: {
			description: string;
			labels?: string[];
			capabilities?: string[];
			version?: string;
		},
	): EntityID {
		const existing = this.nameIndex.get(schema.name);
		if (existing !== undefined && this.world.isAlive(existing)) {
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

	unregister(name: string): void {
		const id = this.nameIndex.get(name);
		if (id !== undefined) {
			this.world.despawn(id);
			this.nameIndex.delete(name);
		}
	}

	get(name: string): CatalogSearchResult | undefined {
		const id = this.nameIndex.get(name);
		if (id === undefined || !this.world.isAlive(id)) return undefined;
		return this.toResult(id, 1.0);
	}

	list(): CatalogSearchResult[] {
		return this.world
			.query(CATALOG_ENTRY_TYPE)
			.map((id) => this.toResult(id, 1.0))
			.filter((r): r is CatalogSearchResult => r !== undefined)
			.sort((a, b) => a.schema.name.localeCompare(b.schema.name));
	}

	search(filter: CatalogSearchFilter): CatalogSearchResult[] {
		const allIds = this.world.query(CATALOG_ENTRY_TYPE);
		const results: CatalogSearchResult[] = [];

		for (const id of allIds) {
			const entry = this.world.get(id, CATALOG_ENTRY_TYPE) as CatalogEntry | undefined;
			if (!entry) continue;

			const labels = (this.world.get(id, LABELS_TYPE) as Labels | undefined)?.values ?? [];
			const capabilities = (this.world.get(id, CAPABILITIES_TYPE) as Capabilities | undefined)?.values ?? [];

			if (filter.role && entry.schema.role !== filter.role) continue;

			if (filter.labels?.length) {
				const hasAll = filter.labels.every((l) => labels.includes(l));
				if (!hasAll) continue;
			}

			if (filter.capabilities?.length) {
				const hasAny = filter.capabilities.some((c) => capabilities.includes(c));
				if (!hasAny) continue;
			}

			let score = 1.0;
			if (filter.text) {
				const lower = filter.text.toLowerCase();
				const searchable = [entry.schema.name, entry.description, entry.schema.role, ...labels, ...capabilities]
					.join(" ")
					.toLowerCase();

				if (!searchable.includes(lower)) continue;

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

	get size(): number {
		return this.world.query(CATALOG_ENTRY_TYPE).length;
	}

	getWorld(): World {
		return this.world;
	}

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
