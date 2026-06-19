export { type BoardOrganOptions, createBoardOrgan } from "./organ.js";

import type { Organ } from "@dpopsuev/alef-kernel";
import { createBoardOrgan } from "./organ.js";

export function createOrgan(opts: { cwd: string; sessionDir?: string }): Organ {
	const sessionDir = opts.sessionDir ?? opts.cwd;
	return createBoardOrgan({ sessionDir });
}
