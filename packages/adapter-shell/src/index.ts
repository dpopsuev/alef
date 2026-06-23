export {
	createShellOrgan,
	createShellOrgan as createShellAdapter,
	DEFAULT_GUARD_RULES,
	type GuardResult,
	type GuardRule,
	guardCommand,
	type ShellOrganOptions,
	type ShellOrganOptions as ShellAdapterOptions,
} from "./adapter.js";
export { shouldUseWindowsShell, waitForChildProcess } from "./child-process.js";

import type { Adapter, AdapterLogger } from "@dpopsuev/alef-kernel";
import { createShellOrgan } from "./adapter.js";
export function createOrgan(opts: {
	cwd: string;
	actions?: string[];
	logger?: AdapterLogger;
	blockedPatterns?: readonly RegExp[];
}): Adapter {
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
