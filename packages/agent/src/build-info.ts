import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function exec(cmd: string): string {
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch {
		return "unknown";
	}
}

function readVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf-8")) as {
			version?: string;
		};
		return pkg.version ?? "dev";
	} catch {
		return "dev";
	}
}

export const BUILD_INFO = {
	version: readVersion(),
	gitHash: exec("git rev-parse --short HEAD"),
	gitBranch: exec("git rev-parse --abbrev-ref HEAD"),
	buildTimestamp: new Date().toISOString(),
} as const;
