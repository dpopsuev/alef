import type { SessionStore } from "../contracts/storage.js";

const AUTO_TITLE_MAX = 60;
const SEARCH_BLOB_MAX = 4_000;
const MAX_TAGS = 5;
const MIN_TITLE_CHARS = 8;
const TITLE_WORD_BREAK_MIN = 20;
const PLAN_THEME_TAG_MAX = 24;

/**
 *
 */
export type MetadataRefreshReason = "first_message" | "compact" | "plan" | "user_tag" | "user_rename";

/**
 *
 */
export interface SessionMetadataFromSummary {
	title?: string;
	tags: string[];
}

/**
 *
 */
export interface SessionMetadataRefreshInput {
	reason: MetadataRefreshReason;
	title?: string;
	tags?: readonly string[];
	/** When true, union incoming tags with existing (capped) instead of replace. */
	mergeTags?: boolean;
	summary?: string;
	recentTexts?: readonly string[];
	/** Tag source for writes; auto for system refresh, user for colon commands. */
	tagSource?: "user" | "auto";
	nameSource?: "user" | "auto";
}

/**
 * Parse ## Goal / ## Tags sections from a compaction summary.
 */
export function parseMetadataFromSummary(summary: string): SessionMetadataFromSummary {
	const titleMatch = summary.match(/##\s*Goal\s*\n+([^\n#]+)/i);
	const rawTitle = titleMatch?.[1]?.trim();
	const title = rawTitle ? provisionalTitleFromText(rawTitle) : undefined;

	const tagsSection = summary.match(/##\s*Tags\s*\n+([^\n#]+(?:\n(?!##)[^\n#]+)*)/i);
	const tags: string[] = [];
	if (tagsSection?.[1]) {
		for (const part of tagsSection[1].split(/[,\n]/)) {
			const tag = part.replace(/^[-*]\s*/, "").trim().toLowerCase().replace(/\s+/g, "-");
			if (tag && !tags.includes(tag)) tags.push(tag);
			if (tags.length >= MAX_TAGS) break;
		}
	}
	return { title, tags };
}

/**
 *
 */
export function normalizeSessionTag(raw: string): string | undefined {
	const tag = raw.trim().toLowerCase().replace(/\s+/g, "-");
	return tag || undefined;
}

/**
 *
 */
export function normalizeSessionTags(tags: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of tags) {
		const tag = normalizeSessionTag(raw);
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		out.push(tag);
		if (out.length >= MAX_TAGS) break;
	}
	return out;
}

/**
 * Short theme tag derived from plan desired text for policy-A merge.
 */
export function planThemeTagFromDesired(desired: string): string | undefined {
	const cleaned = desired
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, PLAN_THEME_TAG_MAX)
		.replace(/-+$/g, "");
	return cleaned || undefined;
}

/**
 *
 */
export function provisionalTitleFromText(text: string): string | undefined {
	const cleaned = text.replace(/\s+/g, " ").trim();
	if (cleaned.length < MIN_TITLE_CHARS) return undefined;
	if (cleaned.startsWith(":")) return undefined;
	if (cleaned.length <= AUTO_TITLE_MAX) return cleaned;
	const slice = cleaned.slice(0, AUTO_TITLE_MAX);
	const lastSpace = slice.lastIndexOf(" ");
	return (lastSpace > TITLE_WORD_BREAK_MIN ? slice.slice(0, lastSpace) : slice).trim();
}

/**
 *
 */
export function provisionalTitleFromMessages(messages: readonly unknown[]): string | undefined {
	for (const message of messages) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- untyped pipeline messages
		const msg = message as { role?: string; content?: unknown };
		if (msg.role !== "user") continue;
		let text = "";
		if (typeof msg.content === "string") text = msg.content;
		else if (Array.isArray(msg.content)) {
			text = msg.content
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- content blocks
				.filter((b): b is { text: string } => typeof (b as { text?: string }).text === "string")
				.map((b) => b.text)
				.join(" ");
		}
		const title = provisionalTitleFromText(text);
		if (title) return title;
	}
	return undefined;
}

/**
 *
 */
export function buildSearchBlob(parts: {
	name?: string;
	tags?: readonly string[];
	summary?: string;
	recentTexts?: readonly string[];
}): string {
	const chunks: string[] = [];
	if (parts.name) chunks.push(parts.name);
	if (parts.tags?.length) chunks.push(parts.tags.join(" "));
	if (parts.summary) chunks.push(parts.summary);
	if (parts.recentTexts?.length) chunks.push(parts.recentTexts.join(" "));
	return chunks.join("\n").slice(0, SEARCH_BLOB_MAX);
}

/**
 * Central session metadata write path — respects user name/tags freeze.
 */
export async function applySessionMetadataRefresh(
	store: SessionStore,
	input: SessionMetadataRefreshInput,
): Promise<void> {
	const nameSource = input.nameSource ?? (input.reason === "user_rename" ? "user" : "auto");
	const tagSource = input.tagSource ?? (input.reason === "user_tag" ? "user" : "auto");

	if (input.title) {
		await store.setName(input.title, { source: nameSource });
	}

	if (input.tags) {
		const incoming = normalizeSessionTags(input.tags);
		const next = input.mergeTags
			? normalizeSessionTags([...store.tags(), ...incoming])
			: incoming;
		await store.setTags(next, { source: tagSource });
	}

	if (input.summary !== undefined || input.recentTexts !== undefined || input.title || input.tags) {
		await store.setSearchBlob(
			buildSearchBlob({
				name: store.name(),
				tags: store.tags(),
				summary: input.summary,
				recentTexts: input.recentTexts,
			}),
		);
	}
}
