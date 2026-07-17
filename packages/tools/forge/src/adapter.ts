import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";
import { branchExists, diffPatch, diffRange, mergeBranches } from "./git-ops.js";
import { forgeRootForCwd, PullStore } from "./store.js";
import { domainEventsFromWebhook } from "./webhook.js";

/**
 *
 */
export interface ForgeAdapterOptions {
	cwd: string;
	/** Override PR store root (tests). Default: `$XDG_DATA_HOME/alef/forge/<cwd-hash>` */
	forgeRoot?: string;
	/** Default author for create/review/merge when not provided. */
	author?: string;
	actions?: readonly string[];
}

const FORGE_PR_CREATE = {
	name: "forge.pr.create",
	description:
		"Open a pull request in the local forge store (git branches + sidecar). Emits pr.opened. No remote forge required.",
	inputSchema: z.object({
		title: z.string().min(1),
		head: z.string().min(1).describe("Source branch"),
		base: z.string().min(1).describe("Target branch"),
		body: z.string().optional(),
		author: z.string().optional(),
	}),
};

const FORGE_PR_LIST = {
	name: "forge.pr.list",
	description: "List pull requests in the local forge store.",
	inputSchema: z.object({
		state: z.enum(["open", "merged", "closed", "all"]).optional(),
	}),
};

const FORGE_PR_GET = {
	name: "forge.pr.get",
	description: "Get one pull request and its git diff summary.",
	inputSchema: z.object({
		number: z.number().min(1).describe("PR number"),
		patch: z.boolean().optional().describe("Include full patch"),
	}),
};

const FORGE_PR_REVIEW = {
	name: "forge.pr.review",
	description: "Submit a PR review on the local store. Emits pr.reviewed.",
	inputSchema: z.object({
		number: z.number().min(1).describe("PR number"),
		body: z.string().min(1).describe("Review comment"),
		event: z.enum(["APPROVED", "REQUEST_CHANGES", "COMMENT"]).optional(),
		author: z.string().optional(),
	}),
};

const FORGE_PR_MERGE = {
	name: "forge.pr.merge",
	description: "Merge a pull request into its base branch via git. Emits pr.updated.",
	inputSchema: z.object({
		number: z.number().min(1).describe("PR number"),
		author: z.string().optional(),
	}),
};

const FORGE_INGEST = {
	name: "forge.ingest",
	description:
		"Optional: ingest external Forgejo/Gitea webhook JSON and publish domain events. Primary path is local forge tools.",
	inputSchema: z.object({
		body: z.unknown().describe("Raw webhook JSON payload"),
	}),
};

/**
 *
 */
export function createForgeAdapter(opts: ForgeAdapterOptions): Adapter {
	const store = new PullStore(opts.forgeRoot ?? forgeRootForCwd(opts.cwd));
	const defaultAuthor = opts.author ?? "alef";
	let mountedBus: Bus | null = null;

	const emit = (type: string, payload: Record<string, unknown>): void => {
		mountedBus?.notification.publish({ type, payload, correlationId: "" });
	};

	return defineAdapter(
		"forge",
		{
			command: {
				"forge.pr.create": typedAction(FORGE_PR_CREATE, (ctx) => {
					const { title, head, base, body, author } = ctx.payload;
					if (!branchExists(opts.cwd, base)) {
						throw new Error(`base branch not found: ${base}`);
					}
					if (!branchExists(opts.cwd, head)) {
						throw new Error(`head branch not found: ${head}`);
					}
					const pull = store.create({
						title,
						body,
						author: author ?? defaultAuthor,
						base,
						head,
					});
					emit("pr.opened", {
						number: pull.number,
						title: pull.title,
						head: pull.head,
						base: pull.base,
						author: pull.author,
					});
					return Promise.resolve(
						withDisplay(
							{ pull },
							{
								text: `Opened PR #${pull.number}: ${pull.title} (${pull.head} → ${pull.base})`,
								mimeType: "text/plain",
							},
						),
					);
				}),
				"forge.pr.list": typedAction(FORGE_PR_LIST, (ctx) => {
					const pulls = store.list(ctx.payload.state);
					const text =
						pulls.length === 0
							? "No pull requests."
							: pulls
									.map(
										(pull) =>
											`#${pull.number} [${pull.state}] ${pull.title} (${pull.head} → ${pull.base})`,
									)
									.join("\n");
					return Promise.resolve(withDisplay({ pulls }, { text, mimeType: "text/plain" }));
				}),
				"forge.pr.get": typedAction(FORGE_PR_GET, (ctx) => {
					const pull = store.get(ctx.payload.number);
					if (!pull) throw new Error(`PR #${ctx.payload.number} not found`);
					const summary = diffRange(opts.cwd, pull.base, pull.head);
					const patch = ctx.payload.patch ? diffPatch(opts.cwd, pull.base, pull.head) : undefined;
					const text = [
						`#${pull.number} [${pull.state}] ${pull.title}`,
						`${pull.head} → ${pull.base}`,
						pull.body || "(no body)",
						"",
						summary || "(empty diff)",
						...(patch ? ["", patch] : []),
					].join("\n");
					return Promise.resolve(withDisplay({ pull, summary, patch }, { text, mimeType: "text/plain" }));
				}),
				"forge.pr.review": typedAction(FORGE_PR_REVIEW, (ctx) => {
					const event = ctx.payload.event ?? "COMMENT";
					const author = ctx.payload.author ?? defaultAuthor;
					const pull = store.review(ctx.payload.number, {
						author,
						body: ctx.payload.body,
						event,
					});
					if (!pull) throw new Error(`PR #${ctx.payload.number} not open`);
					emit("pr.reviewed", {
						number: pull.number,
						state: event,
						body: ctx.payload.body,
						author,
					});
					return Promise.resolve(
						withDisplay(
							{ pull },
							{
								text: `Reviewed PR #${pull.number} (${event})`,
								mimeType: "text/plain",
							},
						),
					);
				}),
				"forge.pr.merge": typedAction(FORGE_PR_MERGE, (ctx) => {
					const existing = store.get(ctx.payload.number);
					if (!existing || existing.state !== "open") {
						throw new Error(`PR #${ctx.payload.number} not open`);
					}
					const author = ctx.payload.author ?? defaultAuthor;
					const { mergeCommit } = mergeBranches(
						opts.cwd,
						existing.base,
						existing.head,
						`Merge PR #${existing.number}: ${existing.title}`,
					);
					const pull = store.markMerged(existing.number, { mergedBy: author, mergeCommit });
					if (!pull) throw new Error(`failed to mark PR #${existing.number} merged`);
					emit("pr.updated", {
						number: pull.number,
						action: "merged",
						mergeCommit,
					});
					return Promise.resolve(
						withDisplay(
							{ pull },
							{
								text: `Merged PR #${pull.number} → ${mergeCommit.slice(0, 7)}`,
								mimeType: "text/plain",
							},
						),
					);
				}),
				"forge.ingest": typedAction(FORGE_INGEST, (ctx) => {
					const events = domainEventsFromWebhook(ctx.payload.body);
					for (const event of events) {
						emit(event.type, event.payload);
					}
					return Promise.resolve(
						withDisplay(
							{ published: events.length, events },
							{
								text: `Published ${events.length} domain event(s) from webhook`,
								mimeType: "text/plain",
							},
						),
					);
				}),
			},
		},
		{
			description:
				"Local forge: git branches + durable PR sidecar store. SoR for pull requests; emits pr.* domain events. Optional webhook ingest for external forges.",
			directives: [
				"Open work with forge.pr.create after committing on a branch — no Forgejo/Gitea URL required.",
				"Reviewers use forge.pr.get + forge.pr.review; quality and merge use forge.pr.merge.",
				"Domain events pr.opened / pr.updated / pr.reviewed feed the work queue — do not poll the store.",
				"forge.ingest is optional bridge for external webhooks; primary path is local tools.",
			],
			actions: opts.actions,
			onMount: (bus) => {
				mountedBus = bus;
			},
			onUnmount: () => {
				mountedBus = null;
			},
		},
	);
}
