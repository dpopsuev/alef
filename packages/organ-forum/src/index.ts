export { createForumOrgan, type ForumOrganOptions } from "./organ.js";

import type { Organ } from "@dpopsuev/alef-kernel";
import { createForumOrgan } from "./organ.js";

export function createOrgan(opts: { cwd: string; sessionDir?: string }): Organ {
	const sessionDir = opts.sessionDir ?? opts.cwd;
	return createForumOrgan({ sessionDir });
}
