import { execSync } from "node:child_process";
import type { Release } from "../../update/release-checker.js";
import { checkLatestRelease } from "../../update/release-checker.js";

// ---------------------------------------------------------------------------
// ISP: segregated interfaces -- each consumer depends only on what it calls
// ---------------------------------------------------------------------------

/** Git working-tree operations (dev channel only). */
export interface GitOps {
	statusPorcelain(): string;
	pull(): void;
	checkStatus(): string;
	installDeps(): void;
}

/** Global package installation (stable channel only). */
export interface PackageInstaller {
	installGlobal(spec: string): void;
}

/** Release availability check (stable channel only). */
export interface ReleaseChecker {
	check(currentVersion: string): Promise<Release | null>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 *
 */
export type UpdateResult =
	| { kind: "aborted-dirty" }
	| { kind: "check"; detail: string }
	| { kind: "rebuilt" }
	| { kind: "respawn" }
	| { kind: "up-to-date" }
	| { kind: "available"; release: Release }
	| { kind: "failed"; message: string };

// ---------------------------------------------------------------------------
// Dev channel update
// ---------------------------------------------------------------------------

/**
 *
 */
export interface DevUpdateInput {
	pull: boolean;
	force: boolean;
	checkOnly: boolean;
	git: GitOps;
	rebuild?: () => Promise<void>;
	respawn: () => Promise<void>;
}

/** Dev update: build local code, optionally pull upstream first. */
export async function runDevUpdate(input: DevUpdateInput): Promise<UpdateResult> {
	const { pull, force, checkOnly, git, rebuild, respawn } = input;
	try {
		if (checkOnly) {
			return { kind: "check", detail: git.checkStatus().trim() || "git check complete" };
		}

		if (pull) {
			const dirty = git.statusPorcelain().trim();
			if (dirty && !force) return { kind: "aborted-dirty" };
			git.pull();
			git.installDeps();
		}

		if (rebuild) {
			await rebuild();
			return { kind: "rebuilt" };
		}
		await respawn();
		return { kind: "respawn" };
	} catch (error) {
		return { kind: "failed", message: error instanceof Error ? error.message : "unknown error" };
	}
}

// ---------------------------------------------------------------------------
// Stable channel update
// ---------------------------------------------------------------------------

/**
 *
 */
export interface StableUpdateInput {
	checkOnly: boolean;
	version: string;
	releases: ReleaseChecker;
	packages: PackageInstaller;
	respawn: () => Promise<void>;
}

/** Stable update: check release, install globally, respawn. */
export async function runStableUpdate(input: StableUpdateInput): Promise<UpdateResult> {
	const { checkOnly, version, releases, packages, respawn } = input;
	try {
		const release = await releases.check(version);
		if (!release) return { kind: "up-to-date" };
		if (checkOnly) return { kind: "available", release };

		packages.installGlobal(`@dpopsuev/alef@${release.version}`);
		await respawn();
		return { kind: "respawn" };
	} catch (error) {
		return { kind: "failed", message: error instanceof Error ? error.message : "unknown error" };
	}
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Parse :update flags. */
export function parseUpdateArgs(args: readonly string[]): { pull: boolean; force: boolean; checkOnly: boolean } {
	return {
		pull: args.includes("--pull"),
		force: args.includes("--force"),
		checkOnly: args.includes("--check"),
	};
}

// ---------------------------------------------------------------------------
// Default implementations (factories)
// ---------------------------------------------------------------------------

/** Default git ops backed by execSync. */
export function createDefaultGitOps(): GitOps {
	return {
		statusPorcelain: () => execSync("git status --porcelain", { encoding: "utf-8" }),
		pull: () => {
			execSync("git pull", { stdio: "inherit" });
		},
		checkStatus: () => {
			try {
				return execSync("git fetch --dry-run 2>&1 || git status -sb", { encoding: "utf-8" });
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
		installDeps: () => {
			execSync("npm install", { stdio: "inherit" });
		},
	};
}

/** Default package installer backed by execSync. */
export function createDefaultPackageInstaller(): PackageInstaller {
	return {
		installGlobal: (spec) => {
			const npmCmd = process.env.npm_execpath ? `${process.execPath} "${process.env.npm_execpath}"` : "npm";
			execSync(`${npmCmd} install -g ${spec}`, { stdio: "inherit" });
		},
	};
}

/** Default release checker backed by GitHub API. */
export function createDefaultReleaseChecker(): ReleaseChecker {
	return {
		check: (current) => checkLatestRelease("dpopsuev", "alef", current),
	};
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// (restart architecture: pending -- exit code 75 convention defined in reboot-port.ts)
