import { describe, expect, it } from "vitest";
import type { SessionStore } from "../src/contracts/storage.js";
import {
	applySessionMetadataRefresh,
	buildSearchBlob,
	parseMetadataFromSummary,
	planThemeTagFromDesired,
	provisionalTitleFromMessages,
	provisionalTitleFromText,
} from "../src/context/metadata.js";

function memoryStore(): SessionStore & {
	_name?: string;
	_nameSource?: "user" | "auto";
	_tags: string[];
	_tagsSource?: "user" | "auto";
	_searchBlob?: string;
} {
	const store = {
		id: "t",
		path: "/t",
		_name: undefined as string | undefined,
		_nameSource: undefined as "user" | "auto" | undefined,
		_tags: [] as string[],
		_tagsSource: undefined as "user" | "auto" | undefined,
		_searchBlob: undefined as string | undefined,
		async append() {},
		async events() {
			return [];
		},
		async turns() {
			return [];
		},
		async hitCounts() {
			return new Map();
		},
		async adapterHistory() {
			return [];
		},
		name() {
			return store._name;
		},
		nameSource() {
			return store._nameSource;
		},
		async setName(name: string, options?: { source?: "user" | "auto" }) {
			const source = options?.source ?? "user";
			if (source === "auto" && store._nameSource === "user") return;
			store._name = name;
			store._nameSource = source;
		},
		tags() {
			return store._tags;
		},
		tagsSource() {
			return store._tagsSource;
		},
		async setTags(tags: readonly string[], options?: { source?: "user" | "auto" }) {
			const source = options?.source ?? "user";
			if (source === "auto" && store._tagsSource === "user") return;
			store._tags = [...tags];
			store._tagsSource = source;
		},
		searchBlob() {
			return store._searchBlob;
		},
		async setSearchBlob(blob: string) {
			store._searchBlob = blob;
		},
		async isEmpty() {
			return !store._name && true;
		},
		async destroy() {},
	};
	return store;
}

describe("session metadata helpers", { tags: ["unit"] }, () => {
	it("parses goal title and tags from summary", () => {
		const meta = parseMetadataFromSummary(`## Goal
Fix session picker preview fidelity

## Progress
- [x] projector

## Tags
tui, bugfix, picker
`);
		expect(meta.title).toBe("Fix session picker preview fidelity");
		expect(meta.tags).toEqual(["tui", "bugfix", "picker"]);
	});

	it("provisionalTitleFromText rejects short and slash commands", () => {
		expect(provisionalTitleFromText("ok")).toBeUndefined();
		expect(provisionalTitleFromText(":compact")).toBeUndefined();
		expect(provisionalTitleFromText("Fix the session picker rendering")).toBe(
			"Fix the session picker rendering",
		);
	});

	it("provisionalTitleFromMessages uses first substantive user message", () => {
		expect(
			provisionalTitleFromMessages([
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
				{ role: "user", content: "Implement cwd/all session picker scope" },
			]),
		).toBe("Implement cwd/all session picker scope");
	});

	it("buildSearchBlob concatenates fields", () => {
		const blob = buildSearchBlob({
			name: "Picker work",
			tags: ["tui"],
			summary: "Goal stuff",
			recentTexts: ["hello"],
		});
		expect(blob).toContain("Picker work");
		expect(blob).toContain("tui");
		expect(blob).toContain("hello");
	});

	it("planThemeTagFromDesired normalizes desired text", () => {
		expect(planThemeTagFromDesired("Add Session Picker Scope!")).toBe("add-session-picker-scope");
	});

	it("applySessionMetadataRefresh freezes user name and tags", async () => {
		const store = memoryStore();
		await applySessionMetadataRefresh(store, {
			reason: "user_rename",
			title: "Manual",
			nameSource: "user",
		});
		await applySessionMetadataRefresh(store, {
			reason: "user_tag",
			tags: ["mine"],
			tagSource: "user",
		});
		await applySessionMetadataRefresh(store, {
			reason: "compact",
			title: "Auto title",
			tags: ["llm"],
		});
		expect(store.name()).toBe("Manual");
		expect(store.tags()).toEqual(["mine"]);
	});

	it("applySessionMetadataRefresh merges tags for plan reason", async () => {
		const store = memoryStore();
		await store.setTags(["tui"], { source: "auto" });
		await applySessionMetadataRefresh(store, {
			reason: "plan",
			title: "Ship plan retitle policy",
			tags: ["ship-plan-retitle-policy"],
			mergeTags: true,
		});
		expect(store.name()).toBe("Ship plan retitle policy");
		expect(store.tags()).toEqual(["tui", "ship-plan-retitle-policy"]);
	});
});
