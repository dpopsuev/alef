export { createDiscourseOrgan, type DiscourseOrganOptions } from "./adapter.js";
export { DiscourseStore } from "./store.js";
export type { Post, ThreadInfo, TopicSummary } from "./types.js";

import type { Adapter } from "@dpopsuev/alef-kernel";
import { createDiscourseOrgan } from "./adapter.js";

export function createOrgan(opts: { cwd: string; sessionDir?: string }): Adapter {
	const sessionDir = opts.sessionDir ?? opts.cwd;
	return createDiscourseOrgan({ sessionDir });
}
