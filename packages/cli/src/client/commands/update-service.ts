import { execSync } from "node:child_process";
import { getRebootPort, RESTART_EXIT_CODE } from "../../boot/reboot-port.js";
import type { Release } from "../../update/release-checker.js";
import { checkLatestRelease } from "../../update/release-checker.js";

/** Injectable shell side-effects for :update. */
export interface UpdateShell {
	gitStatusPorcelain(): string;
	gitPull(): void;
	gitCheckStatus(): string;
	npmInstall(): void;
	npmInstallGlobal(spec: string): void;
	build(): void;
	checkRelease(currentVersion: string): Promise<Release | null>;
}

/** Discriminated result of runUpdate for UI adapters. */
export type UpdateResult =
	| { kind: "aborted-dirty" }
	| { kind: "check"; detail: string }
	| { kind: "reloaded" }
	| { kind: "respawn" }
	| { kind: "up-to-date" }
	| { kind: "available"; release: Release }
	| { kind: "failed"; message: string };

/** Inputs for pure update orchestration. */
export interface RunUpdateInput {
	channel: "dev" | "stable";
	force: boolean;
	checkOnly: boolean;
	version: string;
	shell: UpdateShell;
	rebuild?: () => Promise<void>;
	respawn: () => Promise<void>;
}

/** Parse :update flags. */
export function parseUpdateArgs(args: readonly string[]): { force: boolean; checkOnly: boolean } {
	return {
		force: args.includes("--force"),
		checkOnly: args.includes("--check"),
	};
}

/** Pure update orchestration -- inject shell/rebuild/respawn for tests. */
export async function runUpdate(input: RunUpdateInput): Promise<UpdateResult> {
	const { channel, force, checkOnly, version, shell, rebuild, respawn } = input;

	try {
		if (channel === "dev") {
			const dirty = shell.gitStatusPorcelain().trim();
			if (dirty && !force) return { kind: "aborted-dirty" };

			if (checkOnly) {
				return { kind: "check", detail: shell.gitCheckStatus().trim() || "git check complete" };
			}

			shell.gitPull();
			shell.npmInstall();
			shell.build();

			if (rebuild) {
				await rebuild();
				return { kind: "reloaded" };
			}
			await respawn();
			return { kind: "respawn" };
		}

		const release = await shell.checkRelease(version);
		if (!release) return { kind: "up-to-date" };

		if (checkOnly) return { kind: "available", release };

		shell.npmInstallGlobal(`@dpopsuev/alef@${release.version}`);
		await respawn();
		return { kind: "respawn" };
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown error";
		return { kind: "failed", message };
	}
}

/** Outcome of :restart. */
export type RestartResult = { kind: "reloaded" } | { kind: "respawn" };

/** True while a warm reboot is in progress. Suppresses false "session ended" errors. */
export let rebootInProgress = false;

/** Prefer rebuild port; otherwise respawn. */
export async function runRestart(input: {
	rebuild?: () => Promise<void>;
	respawn: () => Promise<void>;
}): Promise<RestartResult> {
	if (input.rebuild) {
		rebootInProgress = true;
		try {
			await input.rebuild();
		} finally {
			rebootInProgress = false;
		}
		return { kind: "reloaded" };
	}
	await input.respawn();
	return { kind: "respawn" };
}

/** Default shell backed by execSync / GitHub releases. */
export function createDefaultUpdateShell(): UpdateShell {
	return {
		gitStatusPorcelain: () => execSync("git status --porcelain", { encoding: "utf-8" }),
		gitPull: () => {
			execSync("git pull", { stdio: "inherit" });
		},
		gitCheckStatus: () => {
			try {
				return execSync("git fetch --dry-run 2>&1 || git status -sb", { encoding: "utf-8" });
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
		npmInstall: () => {
			execSync("npm install", { stdio: "inherit" });
		},
		npmInstallGlobal: (spec) => {
			const npmCmd = process.env.npm_execpath ? `${process.execPath} "${process.env.npm_execpath}"` : "npm";
			execSync(`${npmCmd} install -g ${spec}`, { stdio: "inherit" });
		},
		build: () => {
			execSync("npm run build", { stdio: "inherit" });
		},
		checkRelease: (current) => checkLatestRelease("dpopsuev", "alef", current),
	};
}

/** Resolve reboot callback from the bootloader's RebootPort when present. */
export function resolveReboot(): (() => Promise<void>) | undefined {
	const port = getRebootPort();
	if (!port) return undefined;
	return () => port.reboot();
}

/**
 * Signal the wrapper to respawn us by exiting with RESTART_EXIT_CODE.
 * The wrapper (bin/alef.js) catches this code and spawns a fresh child.
 */
export function defaultRespawn(_sessionId: string): Promise<never> {
	process.exit(RESTART_EXIT_CODE);
}
