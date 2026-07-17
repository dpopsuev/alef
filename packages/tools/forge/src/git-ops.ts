import { execFileSync } from "node:child_process";

/**
 *
 */
export function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 }).trim();
}

/**
 *
 */
export function branchExists(cwd: string, ref: string): boolean {
	try {
		git(cwd, ["rev-parse", "--verify", ref]);
		return true;
	} catch {
		return false;
	}
}

/**
 *
 */
export function revParse(cwd: string, ref: string): string {
	return git(cwd, ["rev-parse", ref]);
}

/**
 * Combined diff for a PR (three-dot).
 */
export function diffRange(cwd: string, base: string, head: string): string {
	return git(cwd, ["diff", "--stat", `${base}...${head}`]);
}

/**
 * Full patch for a PR (three-dot).
 */
export function diffPatch(cwd: string, base: string, head: string): string {
	return git(cwd, ["diff", `${base}...${head}`]);
}

/**
 * Merge head into base. Returns merge commit SHA.
 */
export function mergeBranches(cwd: string, base: string, head: string, message: string): { mergeCommit: string } {
	git(cwd, ["checkout", base]);
	git(cwd, ["merge", "--no-ff", "-m", message, head]);
	return { mergeCommit: revParse(cwd, "HEAD") };
}
