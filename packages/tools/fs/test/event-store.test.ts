import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryEventStore, type TimelineEvent } from "../src/event-store.js";

describe("InMemoryEventStore", { tags: ["unit"] }, () => {
	let store: InMemoryEventStore;

	beforeEach(() => {
		store = new InMemoryEventStore({ maxEvents: 100, maxAge: 1000 });
	});

	it("records and retrieves events", () => {
		const event: TimelineEvent = {
			timestamp: Date.now(),
			type: "modified",
			path: "/test/file.ts",
			trigger: "fs.write",
		};

		store.record(event);

		const result = store.query({});
		expect(result.events).toHaveLength(1);
		expect(result.events[0]).toEqual(event);
		expect(result.total).toBe(1);
	});

	it("filters by path - exact match", () => {
		const now = Date.now();
		store.record({ timestamp: now, type: "modified", path: "/src/a.ts" });
		store.record({ timestamp: now + 1, type: "modified", path: "/src/b.ts" });
		store.record({ timestamp: now + 2, type: "modified", path: "/test/c.ts" });

		const result = store.query({ path: "/src/a.ts" });
		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.path).toBe("/src/a.ts");
	});

	it("filters by path - directory prefix", () => {
		const now = Date.now();
		store.record({ timestamp: now, type: "modified", path: "/src/a.ts" });
		store.record({ timestamp: now + 1, type: "modified", path: "/src/sub/b.ts" });
		store.record({ timestamp: now + 2, type: "modified", path: "/test/c.ts" });

		const result = store.query({ path: "/src" });
		expect(result.events).toHaveLength(2);
		expect(result.events.map((e) => e.path)).toEqual(["/src/a.ts", "/src/sub/b.ts"]);
	});

	it("filters by time range - since", () => {
		const base = 1000;
		store.record({ timestamp: base, type: "modified", path: "/a.ts" });
		store.record({ timestamp: base + 100, type: "modified", path: "/b.ts" });
		store.record({ timestamp: base + 200, type: "modified", path: "/c.ts" });

		const result = store.query({ since: base + 100 });
		expect(result.events).toHaveLength(2);
		expect(result.events.map((e) => e.path)).toEqual(["/b.ts", "/c.ts"]);
	});

	it("filters by time range - until", () => {
		const base = 1000;
		store.record({ timestamp: base, type: "modified", path: "/a.ts" });
		store.record({ timestamp: base + 100, type: "modified", path: "/b.ts" });
		store.record({ timestamp: base + 200, type: "modified", path: "/c.ts" });

		const result = store.query({ until: base + 100 });
		expect(result.events).toHaveLength(2);
		expect(result.events.map((e) => e.path)).toEqual(["/a.ts", "/b.ts"]);
	});

	it("filters by time range - since and until", () => {
		const base = 1000;
		store.record({ timestamp: base, type: "modified", path: "/a.ts" });
		store.record({ timestamp: base + 100, type: "modified", path: "/b.ts" });
		store.record({ timestamp: base + 200, type: "modified", path: "/c.ts" });
		store.record({ timestamp: base + 300, type: "modified", path: "/d.ts" });

		const result = store.query({ since: base + 100, until: base + 200 });
		expect(result.events).toHaveLength(2);
		expect(result.events.map((e) => e.path)).toEqual(["/b.ts", "/c.ts"]);
	});

	it("filters by event types", () => {
		const now = Date.now();
		store.record({ timestamp: now, type: "created", path: "/a.ts" });
		store.record({ timestamp: now + 1, type: "modified", path: "/b.ts" });
		store.record({ timestamp: now + 2, type: "deleted", path: "/c.ts" });
		store.record({ timestamp: now + 3, type: "modified", path: "/d.ts" });

		const result = store.query({ events: ["modified"] });
		expect(result.events).toHaveLength(2);
		expect(result.events.map((e) => e.path)).toEqual(["/b.ts", "/d.ts"]);
		expect(result.events.every((e) => e.type === "modified")).toBe(true);
	});

	it("filters by multiple event types", () => {
		const now = Date.now();
		store.record({ timestamp: now, type: "created", path: "/a.ts" });
		store.record({ timestamp: now + 1, type: "modified", path: "/b.ts" });
		store.record({ timestamp: now + 2, type: "deleted", path: "/c.ts" });
		store.record({ timestamp: now + 3, type: "renamed", path: "/d.ts" });

		const result = store.query({ events: ["created", "deleted"] });
		expect(result.events).toHaveLength(2);
		expect(result.events.map((e) => e.path)).toEqual(["/a.ts", "/c.ts"]);
	});

	it("applies limit to most recent events", () => {
		for (let i = 0; i < 10; i++) {
			store.record({ timestamp: i, type: "modified", path: `/file${i}.ts` });
		}

		const result = store.query({ limit: 3 });
		expect(result.events).toHaveLength(3);
		expect(result.total).toBe(10);
		expect(result.events.map((e) => e.path)).toEqual(["/file7.ts", "/file8.ts", "/file9.ts"]);
	});

	it("combines multiple filters", () => {
		const base = 1000;
		store.record({ timestamp: base, type: "created", path: "/src/a.ts" });
		store.record({ timestamp: base + 100, type: "modified", path: "/src/b.ts" });
		store.record({ timestamp: base + 200, type: "modified", path: "/src/c.ts" });
		store.record({ timestamp: base + 300, type: "deleted", path: "/test/d.ts" });
		store.record({ timestamp: base + 400, type: "modified", path: "/src/e.ts" });

		const result = store.query({
			path: "/src",
			since: base + 100,
			until: base + 300,
			events: ["modified"],
		});

		expect(result.events).toHaveLength(2);
		expect(result.events.map((e) => e.path)).toEqual(["/src/b.ts", "/src/c.ts"]);
	});

	it("prunes old events by age", () => {
		const old = Date.now() - 2000; // Older than maxAge (1000ms)
		const recent = Date.now();

		store.record({ timestamp: old, type: "modified", path: "/old.ts" });
		store.record({ timestamp: recent, type: "modified", path: "/recent.ts" });

		store.prune(Date.now() - 1000);

		const result = store.query({});
		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.path).toBe("/recent.ts");
	});

	it("enforces max event count", () => {
		const smallStore = new InMemoryEventStore({ maxEvents: 5 });

		for (let i = 0; i < 10; i++) {
			smallStore.record({ timestamp: i, type: "modified", path: `/file${i}.ts` });
		}

		const result = smallStore.query({});
		expect(result.events).toHaveLength(5);
		expect(result.events.map((e) => e.path)).toEqual([
			"/file5.ts",
			"/file6.ts",
			"/file7.ts",
			"/file8.ts",
			"/file9.ts",
		]);
	});

	it("tracks retention window", () => {
		const base = 1000;
		store.record({ timestamp: base, type: "modified", path: "/a.ts" });
		store.record({ timestamp: base + 100, type: "modified", path: "/b.ts" });

		const retention = store.retention();
		expect(retention.count).toBe(2);
		expect(retention.oldest).toBe(base);
	});

	it("clears all events", () => {
		store.record({ timestamp: Date.now(), type: "modified", path: "/a.ts" });
		store.record({ timestamp: Date.now(), type: "modified", path: "/b.ts" });

		expect(store.query({}).total).toBe(2);

		store.clear();

		expect(store.query({}).total).toBe(0);
		expect(store.retention().count).toBe(0);
	});

	it("handles empty store gracefully", () => {
		const result = store.query({});
		expect(result.events).toHaveLength(0);
		expect(result.total).toBe(0);

		const retention = store.retention();
		expect(retention.count).toBe(0);
	});

	it("handles rename events with oldPath", () => {
		const event: TimelineEvent = {
			timestamp: Date.now(),
			type: "renamed",
			path: "/new.ts",
			oldPath: "/old.ts",
		};

		store.record(event);

		// Should match by new path
		expect(store.query({ path: "/new.ts" }).events).toHaveLength(1);

		// Should also match by old path
		expect(store.query({ path: "/old.ts" }).events).toHaveLength(1);
	});

	it("stores additional event metadata", () => {
		const event: TimelineEvent = {
			timestamp: Date.now(),
			type: "modified",
			path: "/file.ts",
			size: 1024,
			diff: "- old\n+ new",
			trigger: "fs.patch",
		};

		store.record(event);

		const result = store.query({});
		expect(result.events[0]).toEqual(event);
		expect(result.events[0]?.size).toBe(1024);
		expect(result.events[0]?.diff).toBe("- old\n+ new");
		expect(result.events[0]?.trigger).toBe("fs.patch");
	});

	it("auto-prunes on record when events exceed maxAge", () => {
		const shortAgeStore = new InMemoryEventStore({ maxAge: 100 });
		const base = Date.now();

		shortAgeStore.record({ timestamp: base - 200, type: "modified", path: "/old.ts" });
		shortAgeStore.record({ timestamp: base, type: "modified", path: "/new.ts" });

		const result = shortAgeStore.query({});
		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.path).toBe("/new.ts");
	});
});
