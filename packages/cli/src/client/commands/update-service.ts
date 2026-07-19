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
	| { kind: "rebuilt" }
	| { kind: "respawn" }
	| { kind: "up-to-date" }
	| { kind: "available"; release: Release }
	| { kind: "failed"; message: string };

/** Inputs for pure update orchestration. */
export interface RunUpdateInput {
	channel: "dev" | "stable";
	pull: boolean;
	force: boolean;
	checkOnly: boolean;
	version: string;
	shell: UpdateShell;
	rebuild?: () => Promise<void>;
	respawn: () => Promise<void>;
}

/** Parse :update flags. */
export function parseUpdateArgs(args: readonly string[]): { pull: boolean; force: boolean; checkOnly: boolean } {
	return {
		pull: args.includes("--pull"),
		force: args.includes("--force"),
		checkOnly: args.includes("--check"),
	};
}

/**
 * Unified update orchestration.
 *
 * Dev mode (no --pull): build local code + restart.
 * Dev mode (--pull):    git pull + npm install + build + restart.
 * Prod mode:            check release + npm install -g + restart.
 */
export async function runUpdate(input: RunUpdateInput): Promise<UpdateResult> {
	const { channel, pull, force, checkOnly, version, shell, rebuild, respawn } = input;

	try {
		if (channel === "dev") {
			if (checkOnly) {
				return { kind: "check", detail: shell.gitCheckStatus().trim() || "git check complete" };
			}

			if (pull) {
				const dirty = shell.gitStatusPorcelain().trim();
				if (dirty && !force) return { kind: "aborted-dirty" };
				shell.gitPull();
				shell.npmInstall();
			}

			if (rebuild) {
				await rebuild();
				return { kind: "rebuilt" };
			}
			shell.build();
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

/** True while a rebuild is in progress. Suppresses false "session ended" errors. */
export const rebootInProgress = false;

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
