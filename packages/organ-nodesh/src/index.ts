export {
	createNodeshOrgan,
	DEFAULT_NODESH_TIMEOUT_S,
	MAX_NODESH_TIMEOUT_S,
	type NodeshOrganOptions,
} from "./organ.js";

import type { Organ, OrganLogger } from "@dpopsuev/alef-spine";
import { createNodeshOrgan } from "./organ.js";
export function createOrgan(opts: { cwd: string; actions?: string[]; logger?: OrganLogger }): Organ {
	return createNodeshOrgan({ cwd: opts.cwd });
}
