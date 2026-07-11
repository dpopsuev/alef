import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Run a shell command synchronously and return its trimmed stdout, or "unknown" on failure. */
function exec(cmd: string): string {
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch {
		return "unknown";
	}
}

/** Read the package version from the nearest package.json, defaulting to "dev". */
function readVersion(): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- package.json shape is well-known
		const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf-8")) as {
			version?: string;
		};
		return pkg.version ?? "dev";
	} catch {
		return "dev";
	}
}

/** Extract date portion (YYYY-MM-DD) from git commit date. */
function readCommitDate(): string {
	const fullDate = exec("git show -s --format=%ci HEAD");
	if (fullDate === "unknown") return "unknown";
	// Extract just the YYYY-MM-DD portion
	const match = fullDate.match(/^(\d{4}-\d{2}-\d{2})/);
	return match?.[1] ?? "unknown";
}

/** Compile-time metadata: semver, git hash, branch, commit date, and build timestamp. */
export const BUILD_INFO = {
	version: readVersion(),
	gitHash: exec("git rev-parse --short HEAD"),
	gitBranch: exec("git rev-parse --abbrev-ref HEAD"),
	gitCommitDate: readCommitDate(),
	buildTimestamp: new Date().toISOString(),
} as const;
