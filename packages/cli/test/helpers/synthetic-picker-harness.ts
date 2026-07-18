/**
 * Session-picker paint harness backed by a real synthetic SQLite corpus.
 *
 * Mirrors production wiring: list entries → SelectItems → SessionPreviewLoader →
 * PreviewSelectList → renderDisplayBlocksToLines (optional memo).
 */
import { performance } from "node:perf_hooks";
import type { SessionListEntry, SessionPreviewProvider } from "@dpopsuev/alef-storage";
import type { SyntheticCorpus } from "@dpopsuev/alef-storage/testing/synthetic-sessions";
import { PreviewSelectList, type SelectItem } from "@dpopsuev/alef-tui";
import { renderDisplayBlocksToLines } from "@dpopsuev/alef-tui/views";
import {
	PreviewLinesMemo,
	previewEntryFingerprint,
	previewPaneLines,
} from "../../src/client/commands/session-preview-cache.js";
import { SESSION_PREVIEW_DEBOUNCE_MS, SessionPreviewLoader } from "../../src/client/commands/session-preview-loader.js";
import { getTheme } from "../../src/client/theme.js";

const listTheme = {
	selectedPrefix: (s: string) => s,
	selectedText: (s: string) => s,
	unselectedText: (s: string) => s,
	description: (s: string) => s,
	selectedDescription: (s: string) => s,
	scrollInfo: (s: string) => s,
	noMatch: (s: string) => s,
};

function shortenCwd(cwd: string | undefined): string {
	if (!cwd) return "";
	const home = process.env.HOME;
	const display = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
	const parts = display.split("/").filter(Boolean);
	if (parts.length <= 2) return display;
	return parts.slice(-2).join("/");
}

function formatMtime(mtime: Date): string {
	return mtime.toISOString().replace("T", " ").slice(0, 16);
}

/** Same shape as pickSession → toItems (keep in sync with sessions.ts). */
export function sessionsToPickerItems(entries: SessionListEntry[], scope: "current" | "all" = "current"): SelectItem[] {
	return [
		{ value: "__new__", label: "New session", description: "Start fresh" },
		...entries.map((session) => {
			const tags = session.tags?.length ? ` · ${session.tags.join(" ")}` : "";
			const cwdPart = scope === "all" && session.cwd ? `${shortenCwd(session.cwd)} · ` : "";
			return {
				value: session.id,
				label: session.name ?? session.id,
				description: `${cwdPart}${formatMtime(session.mtime)}${tags}`,
				searchText: [session.name, session.id, ...(session.tags ?? []), session.searchBlob ?? "", session.cwd ?? ""]
					.filter(Boolean)
					.join(" "),
			};
		}),
	];
}

export interface PickerScrollStats {
	steps: number;
	p50Ms: number;
	p95Ms: number;
	meanMs: number;
	totalMs: number;
	previewFnCalls: number;
	blockRenderCalls: number;
	loadsStarted: number;
	focusedUpdates: number;
}

export interface SyntheticPickerHarness {
	items: SelectItem[];
	loader: SessionPreviewLoader;
	list: PreviewSelectList;
	/** Hold j from first real session to last; measures handleInput+render. */
	scrollTopToBottom: (opts?: { width?: number; settleMs?: number }) => Promise<PickerScrollStats>;
	/** Pre-warm every session preview into the loader cache (skips debounce). */
	warmAllPreviews: (maxTurns?: number) => Promise<void>;
	dispose: () => void;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)]!;
}

export interface CreatePickerHarnessOptions {
	corpus: SyntheticCorpus;
	/** Use production line memo (default true). */
	memoize?: boolean;
	/** Injected sync cost inside block→line render (harness calibration). */
	injectSyncMs?: number;
	/** Skip debounce for warm-all / immediate loads. */
	debounceMs?: number;
	/** When true, invalidate+re-render each step (legacy double-refresh). */
	doubleRefresh?: boolean;
	/** Scope for item descriptions. */
	scope?: "current" | "all";
	/** Override preview provider (defaults to corpus.preview). */
	preview?: SessionPreviewProvider;
}

/**
 * Wire a PreviewSelectList against a synthetic corpus the way pickSession does.
 */
export async function createSyntheticPickerHarness(opts: CreatePickerHarnessOptions): Promise<SyntheticPickerHarness> {
	const memoize = opts.memoize ?? true;
	const injectSyncMs = opts.injectSyncMs ?? 0;
	const scope = opts.scope ?? "current";
	const entries = scope === "all" ? await opts.corpus.listAll() : await opts.corpus.list();
	const items = sessionsToPickerItems(entries, scope);
	const linesMemo = new PreviewLinesMemo();
	let previewFnCalls = 0;
	let blockRenderCalls = 0;

	const loader = new SessionPreviewLoader({
		preview: opts.preview ?? opts.corpus.preview,
		itemValues: () => items.map((item) => item.value),
		onFocusedUpdate: () => {},
		debounceMs: opts.debounceMs ?? SESSION_PREVIEW_DEBOUNCE_MS,
		neighborRadius: 1,
	});

	const previewFn = (item: SelectItem | undefined, previewWidth: number): string[] => {
		previewFnCalls++;
		if (!item || item.value === "__new__") return ["  Start a new conversation"];
		loader.focus(item.value);
		const entry = loader.cache.get(item.value);
		const pane = previewPaneLines(entry, (blocks) => {
			const render = () => {
				blockRenderCalls++;
				if (injectSyncMs > 0) {
					const end = performance.now() + injectSyncMs;
					while (performance.now() < end) {
						/* spin */
					}
				}
				return renderDisplayBlocksToLines(blocks, previewWidth, getTheme());
			};
			if (!memoize) return render();
			return linesMemo.getOrCompute(item.value, previewWidth, previewEntryFingerprint(entry), render);
		});
		if (pane === "start-load") return ["  …"];
		if (pane === "loading") return ["  Loading..."];
		return pane;
	};

	const list = new PreviewSelectList({
		items,
		maxVisible: 12,
		theme: listTheme,
		pinPreviewToEnd: true,
		previewFn,
	});

	return {
		items,
		loader,
		list,
		async warmAllPreviews(maxTurns = 10) {
			const preview = opts.preview ?? opts.corpus.preview;
			const targets = items.filter((item) => item.value !== "__new__");
			await Promise.all(
				targets.map(async (item) => {
					const blocks = await preview.getSessionPreview(item.value, maxTurns);
					loader.cache.set(item.value, {
						turns: maxTurns,
						blocks,
						exhausted: false,
						loading: false,
					});
				}),
			);
		},
		async scrollTopToBottom(scrollOpts) {
			const width = scrollOpts?.width ?? 120;
			previewFnCalls = 0;
			blockRenderCalls = 0;
			const sessionSteps = items.filter((item) => item.value !== "__new__").length;
			if (sessionSteps < 2) {
				return {
					steps: 0,
					p50Ms: 0,
					p95Ms: 0,
					meanMs: 0,
					totalMs: 0,
					previewFnCalls: 0,
					blockRenderCalls: 0,
					loadsStarted: loader.stats.loadsStarted,
					focusedUpdates: loader.stats.focusedUpdates,
				};
			}

			// Start on first real session (skip __new__).
			list.handleInput("j");
			list.render(width);
			if (scrollOpts?.settleMs) {
				await new Promise((resolve) => setTimeout(resolve, scrollOpts.settleMs));
				list.invalidatePreview();
				list.render(width);
			}

			const stepMs: number[] = [];
			for (let step = 1; step < sessionSteps; step++) {
				const t0 = performance.now();
				list.handleInput("j");
				list.render(width);
				if (opts.doubleRefresh) {
					list.invalidatePreview();
					list.render(width);
				}
				stepMs.push(performance.now() - t0);
			}

			const sorted = [...stepMs].sort((a, b) => a - b);
			const totalMs = stepMs.reduce((sum, value) => sum + value, 0);
			return {
				steps: stepMs.length,
				p50Ms: percentile(sorted, 50),
				p95Ms: percentile(sorted, 95),
				meanMs: totalMs / stepMs.length,
				totalMs,
				previewFnCalls,
				blockRenderCalls,
				loadsStarted: loader.stats.loadsStarted,
				focusedUpdates: loader.stats.focusedUpdates,
			};
		},
		dispose() {
			loader.dispose();
			linesMemo.clear();
		},
	};
}
