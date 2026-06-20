export { shouldUseWindowsShell, waitForChildProcess } from "./child-process.js";
export { createShellOrgan, guardCommand, type ShellOrganOptions } from "./organ.js";

import type { Organ, OrganLogger } from "@dpopsuev/alef-kernel";
import { createShellOrgan } from "./organ.js";
export function createOrgan(opts: {
	cwd: string;
	actions?: string[];
	logger?: OrganLogger;
	blockedPatterns?: readonly RegExp[];
}): Organ {
	const actions = opts.actions?.map((a) => (a.includes(".") ? a : `shell.${a}`));
	return createShellOrgan({ ...opts, actions });
}
export {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	killTrackedDetachedChildren,
	type ShellConfig,
	sanitizeBinaryOutput,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "./shell.js";
export {
	createPlatformShellAdapter,
	PosixShellAdapter,
	type ShellAdapter,
	type ShellAdapterContext,
	WindowsShellAdapter,
} from "./shell-adapter.js";
