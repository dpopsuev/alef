export {
	createNodeshOrgan,
	DEFAULT_NODESH_TIMEOUT_S,
	MAX_NODESH_TIMEOUT_S,
	type NodeshOrganOptions,
} from "./adapter.js";

import type { Adapter, BaseAdapterOptions } from "@dpopsuev/alef-kernel";
import { createNodeshOrgan } from "./adapter.js";
export function createOrgan(opts: BaseAdapterOptions & { cwd: string }): Adapter {
	return createNodeshOrgan({ cwd: opts.cwd, actions: opts.actions, logger: opts.logger });
}
