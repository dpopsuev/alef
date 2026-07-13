import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { plansRootForCwd } from "../store.js";
import type { PlanPreviewInput } from "./projector.js";

const PLAN_SUMMARY_PREVIEW_CHARS = 80;

/**
 *
 */
interface PlanIndexFile {
	focusedId?: string | null;
}

/**
 * Load focused workspace plan for picker preview + resume history.
 * Reads $XDG_DATA_HOME/alef/plans/<cwd-hash>/ (multi-plan shelf).
 */
export async function loadPlanPreview(cwd: string | undefined): Promise<PlanPreviewInput | undefined> {
	if (!cwd) return undefined;
	const root = plansRootForCwd(cwd);
	try {
		const indexRaw = await readFile(join(root, "index.json"), "utf-8");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- index written by PlanStore
		const index = JSON.parse(indexRaw) as PlanIndexFile;
		const focusedId = typeof index.focusedId === "string" ? index.focusedId : undefined;
		if (!focusedId) return undefined;

		const raw = await readFile(join(root, `${focusedId}.json`), "utf-8");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- plan.json shape from PlanGraph.toJSON
		const data = JSON.parse(raw) as {
			phase?: string;
			desired?: string;
			current?: string;
			steps?: Array<{ id?: string; status?: string }>;
			summary?: string;
		};
		if (typeof data.phase !== "string" || typeof data.desired !== "string") return undefined;
		const steps = Array.isArray(data.steps) ? data.steps : [];
		const done = steps.filter((s) => s.status === "done" || s.status === "completed").length;
		const active = steps.find((s) => s.status === "active");
		const next = steps.find((s) => s.status === "ready" || s.status === "pending");
		const parts: string[] = [];
		if (steps.length > 0) parts.push(`${done}/${steps.length} done`);
		if (active?.id) parts.push(`active: ${active.id}`);
		else if (next?.id) parts.push(`next: ${next.id}`);
		if (typeof data.summary === "string" && data.summary) parts.push(data.summary.slice(0, PLAN_SUMMARY_PREVIEW_CHARS));
		return {
			phase: data.phase,
			desired: data.desired,
			current: typeof data.current === "string" ? data.current : undefined,
			stepSummary: parts.length > 0 ? parts.join(" · ") : undefined,
		};
	} catch {
		return undefined;
	}
}
