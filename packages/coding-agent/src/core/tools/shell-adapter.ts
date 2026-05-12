import { existsSync } from "node:fs";
import { spawn } from "child_process";
import { waitForChildProcess } from "../../utils/child-process.js";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.js";

export interface ShellAdapterContext {
	command: string;
	cwd: string;
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
	shellPath?: string;
}

export interface ShellAdapter {
	execute(context: ShellAdapterContext): Promise<{ exitCode: number | null }>;
}

async function executeWithDetachedMode(
	context: ShellAdapterContext,
	detached: boolean,
): Promise<{ exitCode: number | null }> {
	const { shell, args } = getShellConfig(context.shellPath);
	if (!existsSync(context.cwd)) {
		throw new Error(`Working directory does not exist: ${context.cwd}\nCannot execute bash commands.`);
	}

	return await new Promise((resolve, reject) => {
		const child = spawn(shell, [...args, context.command], {
			cwd: context.cwd,
			detached,
			env: context.env ?? getShellEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (child.pid) {
			trackDetachedChildPid(child.pid);
		}

		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		if (context.timeout !== undefined && context.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				if (child.pid) {
					killProcessTree(child.pid);
				}
			}, context.timeout * 1000);
		}

		child.stdout?.on("data", context.onData);
		child.stderr?.on("data", context.onData);

		const onAbort = () => {
			if (child.pid) {
				killProcessTree(child.pid);
			}
		};
		if (context.signal) {
			if (context.signal.aborted) {
				onAbort();
			} else {
				context.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		waitForChildProcess(child)
			.then((code) => {
				if (child.pid) {
					untrackDetachedChildPid(child.pid);
				}
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				context.signal?.removeEventListener("abort", onAbort);
				if (context.signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				if (timedOut) {
					reject(new Error(`timeout:${context.timeout}`));
					return;
				}
				resolve({ exitCode: code });
			})
			.catch((error) => {
				if (child.pid) {
					untrackDetachedChildPid(child.pid);
				}
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				context.signal?.removeEventListener("abort", onAbort);
				reject(error);
			});
	});
}

export class PosixShellAdapter implements ShellAdapter {
	async execute(context: ShellAdapterContext): Promise<{ exitCode: number | null }> {
		return await executeWithDetachedMode(context, true);
	}
}

export class WindowsShellAdapter implements ShellAdapter {
	async execute(context: ShellAdapterContext): Promise<{ exitCode: number | null }> {
		return await executeWithDetachedMode(context, false);
	}
}

export function createPlatformShellAdapter(platform: NodeJS.Platform = process.platform): ShellAdapter {
	return platform === "win32" ? new WindowsShellAdapter() : new PosixShellAdapter();
}
