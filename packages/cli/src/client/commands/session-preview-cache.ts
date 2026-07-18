import type { DisplayBlock } from "@dpopsuev/alef-session/context";

export const SESSION_PREVIEW_TURNS_INITIAL = 10;
export const SESSION_PREVIEW_TURNS_STEP = 8;
export const SESSION_PREVIEW_TURNS_MAX = 64;

/**
 *
 */
export interface PreviewCacheEntry {
	turns: number;
	blocks: DisplayBlock[];
	exhausted: boolean;
	loading: boolean;
	error?: string;
}

/** Human-readable preview failure line (no blocks yet). */
export function previewFailureMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message.trim();
	return "preview failed";
}

/** Whether another fetch for `turns` should start. */
export function shouldLoadPreview(existing: PreviewCacheEntry | undefined, turns: number): boolean {
	if (!existing) return true;
	if (existing.loading) return false;
	if (existing.error) return true;
	return existing.turns < turns;
}

/** Apply a successful preview fetch to the cache entry. */
export function settlePreviewSuccess(
	existing: PreviewCacheEntry | undefined,
	turns: number,
	blocks: DisplayBlock[],
): PreviewCacheEntry {
	const exhausted =
		(existing?.blocks.length ?? 0) > 0 &&
		blocks.length <= (existing?.blocks.length ?? 0) &&
		turns > (existing?.turns ?? 0);
	return {
		turns,
		blocks,
		exhausted: exhausted || turns >= SESSION_PREVIEW_TURNS_MAX,
		loading: false,
	};
}

/** Clear loading and record an error; keep any prior blocks. */
export function settlePreviewFailure(
	existing: PreviewCacheEntry | undefined,
	turns: number,
	error: unknown,
): PreviewCacheEntry {
	return {
		turns,
		blocks: existing?.blocks ?? [],
		exhausted: existing?.exhausted ?? false,
		loading: false,
		error: previewFailureMessage(error),
	};
}

/** Lines for the picker preview pane from cache state. */
export function previewPaneLines(
	entry: PreviewCacheEntry | undefined,
	renderBlocks: (blocks: DisplayBlock[]) => string[],
): string[] | "loading" | "start-load" {
	if (entry && entry.blocks.length > 0) {
		return renderBlocks(entry.blocks);
	}
	if (entry?.error) {
		return [`  (preview error: ${entry.error})`];
	}
	if (entry?.loading) return "loading";
	return "start-load";
}

/** Stable key for memoizing rendered preview lines. */
export function previewEntryFingerprint(entry: PreviewCacheEntry | undefined): string {
	if (!entry) return "none";
	return [entry.turns, entry.loading ? 1 : 0, entry.exhausted ? 1 : 0, entry.blocks.length, entry.error ?? ""].join(
		":",
	);
}

/** Memoize expensive block→line rendering across paint cycles. */
export class PreviewLinesMemo {
	private key = "";
	private lines: string[] | undefined;

	getOrCompute(sessionId: string, width: number, fingerprint: string, compute: () => string[]): string[] {
		const next = `${sessionId}\0${width}\0${fingerprint}`;
		if (this.lines && this.key === next) return this.lines;
		this.key = next;
		this.lines = compute();
		return this.lines;
	}

	clear(): void {
		this.key = "";
		this.lines = undefined;
	}
}
