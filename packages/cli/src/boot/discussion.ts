import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { DiscussionRef, DiscussionState, DiscussionSubscription } from "@dpopsuev/alef-kernel/execution";
import type { SessionStore } from "@dpopsuev/alef-session/storage";

/**
 *
 */
function slugPart(value: string): string {
	return (
		value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "workspace"
	);
}

/**
 *
 */
function shortHash(value: string): string {
	return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

/** Stable workspace forum id derived from cwd, with a hash suffix to avoid collisions. */
export function deriveDiscussionForumId(cwd: string): string {
	const base = slugPart(basename(cwd) || cwd);
	return `${base}-${shortHash(cwd)}`;
}

/** Default topic title: user title when present, otherwise the workspace basename. */
export function deriveDiscussionTopicTitle(store: SessionStore, cwd: string): string {
	const storedName = store.name()?.trim();
	if (storedName) return storedName;
	const workspaceName = basename(cwd);
	return workspaceName === "" ? "conversation" : workspaceName;
}

/** Root discussion coordinates for the current session. */
export function deriveDiscussionRef(store: SessionStore, cwd: string): DiscussionRef {
	return {
		forumId: deriveDiscussionForumId(cwd),
		topicId: store.id,
		topicTitle: deriveDiscussionTopicTitle(store, cwd),
	};
}

/** Create the initial home/active discussion state for a freshly booted session. */
export function deriveDiscussionState(store: SessionStore, cwd: string): DiscussionState {
	const root = deriveDiscussionRef(store, cwd);
	const subscription: DiscussionSubscription = {
		discussion: root,
		subscribedAt: Date.now(),
		mode: "participate",
		unreadCount: 0,
		lastReadAt: Date.now(),
		auto: true,
	};
	return { home: root, active: root, subscriptions: [subscription] };
}
