import { LectorGitPort } from "@danypops/alef-lector";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import type { GitStatusSummary, WorkspaceGitPort } from "@dpopsuev/alef-workspace/git-port";
import { z } from "zod";

/**
 *
 */
export interface GitAdapterOptions {
	cwd: string;
	actions?: readonly string[];
	/** Overrides the default real Lector-backed port -- tests inject a fake without a live daemon. */
	gitPort?: WorkspaceGitPort;
}

/** Reconstructs `git status --short`'s exact porcelain text from a structured GitStatusSummary. */
function formatStatusShort(status: GitStatusSummary): string {
	return status.files
		.map((file) => {
			const path = file.renamedFrom ? `${file.renamedFrom} -> ${file.path}` : file.path;
			return `${file.indexStatus}${file.workingDirStatus} ${path}\n`;
		})
		.join("");
}

const GIT_STATUS = {
	name: "git.status",
	description: "Show git status of the working tree.",
	inputSchema: z.object({}),
};

/**
 * Working-tree git helpers. Pull requests live on the forge adapter (local SoR).
 */
export function createGitAdapter(opts: GitAdapterOptions): Adapter {
	return defineAdapter(
		"git",
		{
			command: {
				"git.status": typedAction(GIT_STATUS, async () => {
					const gitPort = opts.gitPort ?? new LectorGitPort(opts.cwd);
					const status = await gitPort.status();
					const output = formatStatusShort(status);
					return withDisplay({ output }, { text: output || "(clean)", mimeType: "text/plain" });
				}),
			},
		},
		{
			actions: opts.actions,
			description: "Git working-tree status. Use forge for pull requests; shell.exec for commit/branch/push.",
			labels: ["git", "vcs"],
			directives: [
				"**git adapter tools**\n" +
					"- git.status shows working tree changes.\n" +
					"- Open/review/merge PRs with forge.pr.* (local store + git branches).\n" +
					"- Use shell.exec for git commit, branch, and push operations.",
			],
		},
	);
}

/**
 *
 */
export function createAdapter(opts: { cwd: string; actions?: string[] }): Adapter {
	return createGitAdapter({
		cwd: opts.cwd,
		actions: opts.actions,
	});
}
