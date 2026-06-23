import type { Adapter } from "@dpopsuev/alef-kernel";
import { defineAdapter, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

const DEFAULT_FORGE_URL = "http://localhost:3000";

export interface GitOrganOptions {
	cwd: string;
	forgeUrl?: string;
	forgeToken?: string;
	actions?: readonly string[];
}

async function forgeApi(opts: GitOrganOptions, method: string, path: string, body?: unknown): Promise<unknown> {
	const url = `${opts.forgeUrl ?? DEFAULT_FORGE_URL}/api/v1${path}`;
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (opts.forgeToken) headers.Authorization = `token ${opts.forgeToken}`;
	const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
	if (!res.ok) throw new Error(`Forge API ${method} ${path}: ${res.status} ${await res.text()}`);
	return res.json();
}

const GIT_STATUS = {
	name: "git.status",
	description: "Show git status of the working tree.",
	inputSchema: z.object({}),
};

const PR_CREATE = {
	name: "git.pr-create",
	description: "Create a pull request on the local Forgejo forge.",
	inputSchema: z.object({
		repo: z.string().min(1).describe("owner/repo"),
		title: z.string().min(1),
		head: z.string().min(1).describe("Source branch"),
		base: z.string().min(1).describe("Target branch"),
		body: z.string().optional(),
	}),
};

const PR_LIST = {
	name: "git.pr-list",
	description: "List pull requests on the local Forgejo forge.",
	inputSchema: z.object({
		repo: z.string().min(1).describe("owner/repo"),
		state: z.enum(["open", "closed", "all"]).optional(),
	}),
};

const PR_REVIEW = {
	name: "git.pr-review",
	description: "Add a review comment to a pull request.",
	inputSchema: z.object({
		repo: z.string().min(1).describe("owner/repo"),
		number: z.number().min(1).describe("PR number"),
		body: z.string().min(1).describe("Review comment"),
		event: z.enum(["APPROVED", "REQUEST_CHANGES", "COMMENT"]).optional(),
	}),
};

const PR_MERGE = {
	name: "git.pr-merge",
	description: "Merge a pull request on the local Forgejo forge.",
	inputSchema: z.object({
		repo: z.string().min(1).describe("owner/repo"),
		number: z.number().min(1).describe("PR number"),
		method: z.enum(["merge", "rebase", "squash"]).optional(),
	}),
};

export function createGitOrgan(opts: GitOrganOptions): Adapter {
	return defineAdapter(
		"git",
		{
			motor: {
				"git.status": typedAction(GIT_STATUS, async () => {
					const { execSync } = await import("node:child_process");
					const output = execSync("git status --short", { cwd: opts.cwd, encoding: "utf-8" });
					return withDisplay({ output }, { text: output || "(clean)", mimeType: "text/plain" });
				}),
				"git.pr-create": typedAction(PR_CREATE, async (ctx) => {
					const { repo, title, head, base, body } = ctx.payload;
					const pr = await forgeApi(opts, "POST", `/repos/${repo}/pulls`, { title, head, base, body });
					return withDisplay(pr as Record<string, unknown>, {
						text: `PR created: ${title}`,
						mimeType: "text/plain",
					});
				}),
				"git.pr-list": typedAction(PR_LIST, async (ctx) => {
					const { repo, state } = ctx.payload;
					const qs = state ? `?state=${state}` : "";
					const prs = await forgeApi(opts, "GET", `/repos/${repo}/pulls${qs}`);
					const list = prs as Array<{ number: number; title: string; state: string }>;
					const text = list.map((p) => `#${p.number} [${p.state}] ${p.title}`).join("\n") || "(none)";
					return withDisplay({ prs: list, count: list.length }, { text, mimeType: "text/plain" });
				}),
				"git.pr-review": typedAction(PR_REVIEW, async (ctx) => {
					const { repo, number, body, event } = ctx.payload;
					const review = await forgeApi(opts, "POST", `/repos/${repo}/pulls/${number}/reviews`, {
						body,
						event: event ?? "COMMENT",
					});
					return withDisplay(review as Record<string, unknown>, {
						text: `Review posted on PR #${number}`,
						mimeType: "text/plain",
					});
				}),
				"git.pr-merge": typedAction(PR_MERGE, async (ctx) => {
					const { repo, number, method } = ctx.payload;
					const result = await forgeApi(opts, "POST", `/repos/${repo}/pulls/${number}/merge`, {
						Do: method ?? "merge",
					});
					return withDisplay(result as Record<string, unknown>, {
						text: `PR #${number} merged.`,
						mimeType: "text/plain",
					});
				}),
			},
		},
		{
			actions: opts.actions,
			description: "Git operations and local Forgejo forge integration.",
			labels: ["git", "forge", "vcs"],
			directives: [
				"**git adapter tools**\n" +
					"- git.status shows working tree changes.\n" +
					"- git.pr-create, git.pr-list, git.pr-review, git.pr-merge interact with the local Forgejo forge.\n" +
					"- Use shell.exec for git commit, push, branch operations.",
			],
		},
	);
}

export function createOrgan(opts: { cwd: string; actions?: string[] }): Adapter {
	return createGitOrgan({
		cwd: opts.cwd,
		actions: opts.actions,
		forgeUrl: process.env.ALEF_FORGE_URL,
		forgeToken: process.env.ALEF_FORGE_TOKEN,
	});
}
