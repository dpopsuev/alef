import type { AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import type { DiscourseProjection } from "@dpopsuev/discourse-capability/ports";
import type { Post, ProjectionRecord } from "@dpopsuev/discourse-capability/types";

/** Adapter-owned call into the external artifact projection API. */
export type ScribeArtifactCall = (action: string, params: Record<string, unknown>) => Promise<string>;

/** Slug one label segment for stable projection identifiers. */
function slugPart(value: string): string {
	return (
		value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "") || "x"
	);
}
/** Serialize one post body with structured projection metadata. */
function contentToText(post: Post): string {
	const body = typeof post.content === "string" ? post.content : JSON.stringify(post.content);
	const metadata = {
		id: post.id,
		replyToPostId: post.replyToPostId,
		references: post.references,
		sequence: post.sequence,
	};
	return `[[alef-discourse-meta ${JSON.stringify(metadata)}]]\n${body}`;
}

/** Idempotent Scribe view driven only by committed outbox records. */
export class ScribeDiscourseProjection implements DiscourseProjection {
	readonly id: string;
	constructor(
		private readonly call: ScribeArtifactCall,
		private readonly scope = "default",
		private readonly logger?: AdapterLogger,
	) {
		this.id = `scribe-${slugPart(scope)}`;
	}

	async project(record: ProjectionRecord): Promise<void> {
		const post = record.post;
		const topicId = `ctx-topic-${slugPart(this.scope)}-${slugPart(post.topicId)}`;
		const threadId = `ctx-thread-${slugPart(this.scope)}-${slugPart(post.topicId)}-${slugPart(post.threadId)}`;
		await this.ensureContext(topicId, `topic ${post.topicId}`, ["role:channel", `topic:${post.topicId}`]);
		await this.ensureContext(
			threadId,
			`thread ${post.topicId}/${post.threadId}`,
			["role:thread", `topic:${post.topicId}`, `thread:${post.threadId}`],
			topicId,
		);
		await this.call("message_add", {
			parent: threadId,
			text: contentToText(post),
			author: post.authorId,
			scope: this.scope,
			operation_id: `${this.id}:${record.sequence}`,
		});
	}

	private async ensureContext(id: string, title: string, extraLabels: string[], parent?: string): Promise<void> {
		try {
			await this.call("get", { id });
			return;
		} catch (error) {
			this.logger?.debug(
				{
					component: "discourse-projection",
					projectionId: this.id,
					contextId: id,
					errorType: error instanceof Error ? error.name : "unknown",
				},
				"projection context absent",
			);
		}
		const labels = ["kind:knowledge.context", ...extraLabels, `project:${this.scope}`];
		try {
			await this.call("create", {
				id,
				title,
				kind: "knowledge.context",
				scope: this.scope,
				labels,
				sections: [{ name: "content", text: title }],
				...(parent === undefined ? {} : { parent }),
			});
		} catch (error) {
			this.logger?.debug(
				{
					component: "discourse-projection",
					projectionId: this.id,
					contextId: id,
					errorType: error instanceof Error ? error.name : "unknown",
				},
				"projection context creation raced",
			);
		}
	}
}
