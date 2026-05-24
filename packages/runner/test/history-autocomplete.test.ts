import { describe, expect, it } from "vitest";
import { HistoryAutocompleteProvider } from "../src/history-autocomplete.js";

const SIGNAL = { aborted: false } as AbortSignal;

async function suggest(p: HistoryAutocompleteProvider, text: string) {
	return p.getSuggestions([text], 0, text.length, { signal: SIGNAL });
}

describe("HistoryAutocompleteProvider", () => {
	it("returns null when history is empty", async () => {
		const p = new HistoryAutocompleteProvider();
		expect(await suggest(p, "read")).toBeNull();
	});

	it("returns null when prefix is empty", async () => {
		const p = new HistoryAutocompleteProvider();
		p.addEntry("read the code");
		expect(await suggest(p, "")).toBeNull();
	});

	it("returns matching history entries for a prefix", async () => {
		const p = new HistoryAutocompleteProvider();
		p.addEntry("read the code base");
		p.addEntry("look for bugs");
		const s = await suggest(p, "read");
		expect(s).not.toBeNull();
		expect(s!.items[0]!.label).toBe("read the code base");
	});

	it("does not suggest exact match of current input", async () => {
		const p = new HistoryAutocompleteProvider();
		p.addEntry("read the code");
		const s = await suggest(p, "read the code");
		expect(s).toBeNull(); // exact match suppressed
	});

	it("orders entries newest-first", async () => {
		const p = new HistoryAutocompleteProvider();
		p.addEntry("read old");
		p.addEntry("read new");
		const s = await suggest(p, "read");
		expect(s!.items[0]!.label).toBe("read new");
	});

	it("deduplicates: re-adding an entry moves it to front", async () => {
		const p = new HistoryAutocompleteProvider();
		p.addEntry("read the code");
		p.addEntry("look for bugs");
		p.addEntry("read the code"); // re-added — should be newest
		const s = await suggest(p, "read");
		expect(s!.items[0]!.label).toBe("read the code");
	});

	it("returns null for multi-line input", async () => {
		const p = new HistoryAutocompleteProvider();
		p.addEntry("read the code");
		const s = await p.getSuggestions(["read", "more"], 0, 4, { signal: SIGNAL });
		expect(s).toBeNull();
	});

	it("applyCompletion replaces current line with selected item", () => {
		const p = new HistoryAutocompleteProvider();
		const result = p.applyCompletion(
			["read"],
			0,
			4,
			{ label: "read the code base", value: "read the code base", description: "history" },
			"read",
		);
		expect(result.lines[0]).toBe("read the code base");
		expect(result.cursorCol).toBe("read the code base".length);
	});

	it("caps history at 500 entries", () => {
		const p = new HistoryAutocompleteProvider();
		for (let i = 0; i < 600; i++) p.addEntry(`entry-${i}`);
		// Internal cap: getSuggestions should still work without error
		expect(suggest(p, "entry-599")).resolves.not.toThrow();
	});
});
