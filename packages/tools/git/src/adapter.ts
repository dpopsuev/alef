import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";

/**
 *
 */
export interface GitAdapterOptions {
	cwd: string;
	actions?: readonly string[];
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
					const { execSync } = await import("node:child_process");
					const output = execSync("git status --short", { cwd: opts.cwd, encoding: "utf-8" });
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
