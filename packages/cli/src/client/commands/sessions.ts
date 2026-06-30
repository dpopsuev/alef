const SESSION_PICKER_MAX_VISIBLE = 12;
const SESSION_PREVIEW_LINES = 12;

/**
 * TUI session picker — vi-modal with preview pane.
 * Delegates to runPicker() for TUI lifecycle.
 */

import type { SelectItem } from "@dpopsuev/alef-tui";
import type { SessionPreviewProvider } from "../../boot/session.js";
import { runPicker } from "./picker.js";

export async function pickSession(
	sessions: Array<{ id: string; path: string; mtime: Date }>,
	preview?: SessionPreviewProvider,
): Promise<string | undefined> {
	if (sessions.length === 0) return undefined;

	const BATCH = 20;
	const batch = sessions.slice(0, BATCH);

	let names: (string | undefined)[] = [];
	if (preview?.getSessionName) {
		const fn = preview.getSessionName.bind(preview);
		names = await Promise.all(batch.map((s) => fn(s.id)));
	}

	const items: SelectItem[] = [
		{ value: "__new__", label: "New session", description: "Start fresh" },
		...batch.map((s, i) => ({
			value: s.id,
			label: names[i] ?? s.id,
			description: s.mtime.toISOString().replace("T", " ").slice(0, 16),
		})),
	];

	const previewCache = new Map<string, string[]>();

	const result = await runPicker({
		title: "Sessions",
		items,
		maxVisible: SESSION_PICKER_MAX_VISIBLE,
		allowFilter: true,
		previewFn: (item, requestRender) => {
			if (!item || item.value === "__new__") return ["  Start a new conversation"];
			if (!preview?.getSessionPreview) return ["  (preview unavailable)"];

			const cached = previewCache.get(item.value);
			if (cached) return cached;

			void preview.getSessionPreview(item.value, SESSION_PREVIEW_LINES).then((lines) => {
				previewCache.set(item.value, lines.length > 0 ? lines : ["  (empty session)"]);
				requestRender?.();
			});
			return ["  Loading..."];
		},
	});

	if (!result || result.value === "__new__") return undefined;
	return result.value;
}
