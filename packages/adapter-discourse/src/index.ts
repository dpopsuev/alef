export { createDiscourseOrgan, type DiscourseOrganOptions } from "./organ.js";
export { DiscourseStore } from "./store.js";
export type { Post, ThreadInfo, TopicSummary } from "./types.js";

import type { Organ } from "@dpopsuev/alef-kernel";
import { createDiscourseOrgan } from "./organ.js";

export function createOrgan(opts: { cwd: string; sessionDir?: string }): Organ {
	const sessionDir = opts.sessionDir ?? opts.cwd;
	return createDiscourseOrgan({ sessionDir });
}
