export {
	createNodeshOrgan,
	DEFAULT_NODESH_TIMEOUT_S,
	MAX_NODESH_TIMEOUT_S,
	type NodeshOrganOptions,
} from "./organ.js";

import type { Adapter, BaseOrganOptions } from "@dpopsuev/alef-kernel";
import { createNodeshOrgan } from "./organ.js";
export function createOrgan(opts: BaseOrganOptions & { cwd: string }): Adapter {
	return createNodeshOrgan({ cwd: opts.cwd, actions: opts.actions, logger: opts.logger });
}
