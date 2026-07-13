import { describe, expect, it } from "vitest";
import {
	type PreviewCacheEntry,
	previewFailureMessage,
	previewPaneLines,
	SESSION_PREVIEW_TURNS_MAX,
	settlePreviewFailure,
	settlePreviewSuccess,
	shouldLoadPreview,
} from "../src/client/commands/session-preview-cache.js";

describe("session preview cache", { tags: ["unit"] }, () => {
	it("loads when empty, skips while loading, retries after error", () => {
		expect(shouldLoadPreview(undefined, 10)).toBe(true);
		expect(shouldLoadPreview({ turns: 10, blocks: [], exhausted: false, loading: true }, 10)).toBe(false);
		expect(shouldLoadPreview({ turns: 10, blocks: [], exhausted: false, loading: false }, 10)).toBe(false);
		expect(shouldLoadPreview({ turns: 10, blocks: [], exhausted: false, loading: false }, 18)).toBe(true);
		expect(shouldLoadPreview({ turns: 10, blocks: [], exhausted: false, loading: false, error: "boom" }, 10)).toBe(
			true,
		);
	});

	it("settlePreviewSuccess clears loading and marks exhausted at max turns", () => {
		const next = settlePreviewSuccess(undefined, SESSION_PREVIEW_TURNS_MAX, [{ kind: "user", text: "hi" }]);
		expect(next.loading).toBe(false);
		expect(next.error).toBeUndefined();
		expect(next.exhausted).toBe(true);
		expect(next.blocks).toHaveLength(1);
	});

	it("settlePreviewSuccess marks exhausted when more turns yield no growth", () => {
		const prev: PreviewCacheEntry = {
			turns: 10,
			blocks: [{ kind: "user", text: "a" }],
			exhausted: false,
			loading: true,
		};
		const next = settlePreviewSuccess(prev, 18, [{ kind: "user", text: "a" }]);
		expect(next.exhausted).toBe(true);
		expect(next.loading).toBe(false);
	});

	it("settlePreviewFailure clears loading and keeps prior blocks", () => {
		const prev: PreviewCacheEntry = {
			turns: 10,
			blocks: [{ kind: "user", text: "cached" }],
			exhausted: false,
			loading: true,
		};
		const next = settlePreviewFailure(prev, 18, new Error("disk gone"));
		expect(next.loading).toBe(false);
		expect(next.error).toBe("disk gone");
		expect(next.blocks).toEqual([{ kind: "user", text: "cached" }]);
		expect(previewFailureMessage("x")).toBe("preview failed");
	});

	it("previewPaneLines shows error when empty, blocks when present, else load signals", () => {
		expect(previewPaneLines(undefined, () => ["rendered"])).toBe("start-load");
		expect(previewPaneLines({ turns: 10, blocks: [], exhausted: false, loading: true }, () => [])).toBe("loading");
		expect(
			previewPaneLines({ turns: 10, blocks: [], exhausted: false, loading: false, error: "nope" }, () => []),
		).toEqual(["  (preview error: nope)"]);
		expect(
			previewPaneLines(
				{ turns: 10, blocks: [{ kind: "user", text: "hi" }], exhausted: false, loading: false },
				() => ["  rendered"],
			),
		).toEqual(["  rendered"]);
	});
});
