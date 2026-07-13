import { spawn } from "node:child_process";

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
