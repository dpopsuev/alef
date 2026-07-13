import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planPreviewFromData, type PlanPreviewInput } from "@dpopsuev/alef-session/context";
import { plansRootForCwd } from "@dpopsuev/alef-session/store";
import { PlanGraph, type PlanPhase } from "./graph.js";

const SHORT_ID_LENGTH = 12;

export { plansRootForCwd };

/**
 *
 */
export type PlanShelfStatus = "active" | "backlog" | "closed";

/**
 *
 */
export interface PlanIndexEntry {
	id: string;
	desired: string;
	phase: PlanPhase;
	status: PlanShelfStatus;
	updatedAt: number;
}

/**
 *
 */
interface PlanIndexFile {
	focusedId: string | null;
	entries: Array<{
		id: string;
		desired: string;
		phase: PlanPhase;
		updatedAt: number;
	}>;
}

/**
 *
 */
export interface PlanStoreOptions {
	cwd: string;
	/** Override on-disk root (tests). Default: $XDG_DATA_HOME/alef/plans/<cwd-hash> */
	plansRoot?: string;
}

/**
 * Workspace-scoped multi-plan shelf: one focus, others backlog, closed kept.
 */
export class PlanStore {
	private readonly root: string;
	private readonly indexPath: string;

	constructor(opts: PlanStoreOptions) {
		this.root = opts.plansRoot ?? plansRootForCwd(opts.cwd);
		this.indexPath = join(this.root, "index.json");
		mkdirSync(this.root, { recursive: true });
	}

	list(filter?: { status?: PlanShelfStatus }): PlanIndexEntry[] {
		const index = this.readIndex();
		const entries = index.entries.map((entry) => this.toEntry(entry, index.focusedId));
		if (!filter?.status) return entries;
		return entries.filter((entry) => entry.status === filter.status);
	}

	focused(): PlanGraph | null {
		const index = this.readIndex();
		if (!index.focusedId) return null;
		return this.load(index.focusedId);
	}

	/** Focused plan as session preview DTO (same path as loadPlanPreview). */
	focusedPreview(): PlanPreviewInput | undefined {
		const plan = this.focused();
		if (!plan) return undefined;
		return planPreviewFromData(plan.toJSON());
	}

	load(id: string): PlanGraph | null {
		return PlanGraph.load(this.planPath(id));
	}

	create(current: string, desired: string, verify: string): PlanGraph {
		const index = this.readIndex();
		if (index.focusedId) {
			index.focusedId = null;
			this.writeIndex(index);
		}

		const id = `plan-${createHash("sha1").update(`${Date.now()}-${desired}`).digest("hex").slice(0, SHORT_ID_LENGTH)}`;
		const plan = new PlanGraph(id, current, desired, verify, this.planPath(id));
		this.upsertEntry(plan);
		this.setFocused(id);
		return plan;
	}

	focus(id: string): PlanGraph {
		const plan = this.load(id);
		if (!plan) throw new Error(`plan ${id} not found`);
		if (plan.phase === "closed") throw new Error(`plan ${id} is closed`);
		this.setFocused(id);
		return plan;
	}

	backlog(id?: string): void {
		const index = this.readIndex();
		const target = id ?? index.focusedId;
		if (!target) return;
		if (index.focusedId === target) {
			index.focusedId = null;
			this.writeIndex(index);
		}
	}

	close(id: string, summary: string): void {
		const plan = this.load(id);
		if (!plan) throw new Error(`plan ${id} not found`);
		plan.close(summary);
		this.upsertEntry(plan);
		const index = this.readIndex();
		if (index.focusedId === id) {
			index.focusedId = null;
			this.writeIndex(index);
		}
	}

	/** Refresh index metadata after in-place PlanGraph mutations. */
	sync(plan: PlanGraph): void {
		this.upsertEntry(plan);
	}

	private planPath(id: string): string {
		return join(this.root, `${id}.json`);
	}

	private toEntry(
		entry: PlanIndexFile["entries"][number],
		focusedId: string | null,
	): PlanIndexEntry {
		const status: PlanShelfStatus =
			entry.phase === "closed" ? "closed" : entry.id === focusedId ? "active" : "backlog";
		return { ...entry, status };
	}

	private setFocused(id: string): void {
		const index = this.readIndex();
		index.focusedId = id;
		this.writeIndex(index);
	}

	private upsertEntry(plan: PlanGraph): void {
		const data = plan.toJSON();
		const index = this.readIndex();
		const next = {
			id: data.id,
			desired: data.desired,
			phase: data.phase,
			updatedAt: data.updatedAt,
		};
		const existing = index.entries.findIndex((entry) => entry.id === data.id);
		if (existing >= 0) index.entries[existing] = next;
		else index.entries.push(next);
		this.writeIndex(index);
	}

	private readIndex(): PlanIndexFile {
		try {
			const raw = readFileSync(this.indexPath, "utf-8");
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- index written by writeIndex
			const parsed = JSON.parse(raw) as PlanIndexFile;
			return {
				focusedId: typeof parsed.focusedId === "string" ? parsed.focusedId : null,
				entries: Array.isArray(parsed.entries) ? parsed.entries : [],
			};
		} catch {
			return { focusedId: null, entries: [] };
		}
	}

	private writeIndex(index: PlanIndexFile): void {
		writeFileSync(this.indexPath, JSON.stringify(index, null, 2), "utf-8");
	}
}
