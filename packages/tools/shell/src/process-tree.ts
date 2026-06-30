import { spawn } from "node:child_process";

const trackedDetachedChildPids = new Set<number>();

/** Register a detached child PID for cleanup on shutdown. */
export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

/** Remove a detached child PID from the tracked set. */
export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

/** Kill all tracked detached child process trees and clear the tracking set. */
export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/** Send SIGKILL to an entire process group (Unix) or taskkill tree (Windows). */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
		} catch {
			/* process already dead */
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* process already dead */
			}
		}
	}
}
