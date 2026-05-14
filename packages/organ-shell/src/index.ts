export { shouldUseWindowsShell, waitForChildProcess } from "./child-process.js";
export { createShellCorpusOrgan, type ShellCorpusOrganOptions } from "./corpus-organ.js";
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
