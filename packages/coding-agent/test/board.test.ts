/**
 * Tests for the Board blackboard and Color Registry.
 *
 * Coverage: palette integrity, color assignment, board CRUD,
 * linked-list entries, edges, scope enforcement, contracts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	ColorRegistry,
	colorAnsi,
	colorLabel,
	colorShort,
	colorTitle,
	GENSEC_COLOR,
	InMemoryBoard,
	lookupColor,
	lookupShade,
	matchesScope,
	PALETTE,
	PALETTE_SIZE,
} from "../src/board/index.js";

// ===========================================================================
// Palette
// ===========================================================================

describe("Palette", () => {
	it("has 12 shade families", () => {
		expect(PALETTE).toHaveLength(12);
	});

	it("each shade has 12 colors", () => {
		for (const shade of PALETTE) {
			expect(shade.colors).toHaveLength(12);
		}
	});

	it("total palette size is 144", () => {
		expect(PALETTE_SIZE).toBe(144);
	});

	it("all color names are unique", () => {
		const names = new Set<string>();
		for (const shade of PALETTE) {
			for (const color of shade.colors) {
				expect(names.has(color.name)).toBe(false);
				names.add(color.name);
			}
		}
		expect(names.size).toBe(144);
	});

	it("all hex values are valid 7-char format", () => {
		for (const shade of PALETTE) {
			for (const color of shade.colors) {
				expect(color.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
			}
		}
	});

	it("lookupShade finds known shades", () => {
		expect(lookupShade("red")).toBeTruthy();
		expect(lookupShade("blue")).toBeTruthy();
		expect(lookupShade("black")).toBeTruthy();
		expect(lookupShade("nonexistent")).toBeUndefined();
	});

	it("lookupColor finds colors across shades", () => {
		const crimson = lookupColor("crimson");
		expect(crimson).toBeTruthy();
		expect(crimson!.shade).toBe("red");

		const onyx = lookupColor("onyx");
		expect(onyx).toBeTruthy();
		expect(onyx!.shade).toBe("black");

		expect(lookupColor("nonexistent")).toBeUndefined();
	});
});

// ===========================================================================
// Color Registry
// ===========================================================================

describe("ColorRegistry", () => {
	let registry: ColorRegistry;

	beforeEach(() => {
		registry = new ColorRegistry();
	});

	it("assigns a unique color", () => {
		const color = registry.assign("worker", "test-project");
		expect(color.name).toBeTruthy();
		expect(color.role).toBe("worker");
		expect(color.collective).toBe("test-project");
		expect(color.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
	});

	it("assigns unique colors on repeated calls", () => {
		const colors = new Set<string>();
		for (let i = 0; i < 10; i++) {
			const c = registry.assign("worker", "proj");
			expect(colors.has(c.name)).toBe(false);
			colors.add(c.name);
		}
	});

	it("assignInGroup uses the specified shade", () => {
		const color = registry.assignInGroup("blue", "scout", "proj");
		const found = lookupColor(color.name);
		expect(found!.shade).toBe("blue");
	});

	it("assignInGroup throws on unknown shade", () => {
		expect(() => registry.assignInGroup("fantasy", "worker", "proj")).toThrow("Unknown shade");
	});

	it("set() assigns a specific color", () => {
		const color = registry.set("red", "crimson", "reviewer", "proj");
		expect(color.name).toBe("crimson");
		expect(color.hex).toBe("#DC143C");
	});

	it("set() rejects duplicate assignment", () => {
		registry.set("red", "crimson", "worker", "proj");
		expect(() => registry.set("red", "crimson", "reviewer", "proj")).toThrow("already assigned");
	});

	it("set() rejects wrong shade", () => {
		expect(() => registry.set("blue", "crimson", "worker", "proj")).toThrow("belongs to shade");
	});

	it("assignWithPreference tries preferred first", () => {
		const color = registry.assignWithPreference({ shade: "green", color: "jade" }, "scout", "proj");
		expect(color.name).toBe("jade");
	});

	it("assignWithPreference falls back when preferred is taken", () => {
		registry.set("green", "jade", "worker", "proj");
		const color = registry.assignWithPreference({ shade: "green", color: "jade" }, "scout", "proj");
		expect(color.name).not.toBe("jade"); // jade is taken
		// Should still be a green shade
		const found = lookupColor(color.name);
		expect(found!.shade).toBe("green");
	});

	it("release() frees a color for reuse", () => {
		const color = registry.set("red", "crimson", "worker", "proj");
		expect(registry.active).toBe(1);
		registry.release(color);
		expect(registry.active).toBe(0);

		// Can reassign
		const reused = registry.set("red", "crimson", "reviewer", "proj2");
		expect(reused.name).toBe("crimson");
	});

	it("get() finds assigned color by name", () => {
		registry.set("blue", "azure", "worker", "proj");
		expect(registry.get("azure")).toBeTruthy();
		expect(registry.get("nonexistent")).toBeUndefined();
	});

	it("colorTitle formats heraldic name", () => {
		expect(colorTitle(GENSEC_COLOR)).toBe("onyx secretary of onyx system");
	});

	it("colorLabel formats compact label", () => {
		expect(colorLabel(GENSEC_COLOR)).toBe("[onyx·onyx|secretary]");
	});

	it("colorShort returns just the name", () => {
		expect(colorShort(GENSEC_COLOR)).toBe("onyx");
	});

	it("colorAnsi returns ANSI escape code", () => {
		const ansi = colorAnsi(GENSEC_COLOR);
		expect(ansi).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/);
	});
});

// ===========================================================================
// Board — CRUD operations
// ===========================================================================

describe("InMemoryBoard", () => {
	let board: InMemoryBoard;

	beforeEach(() => {
		board = new InMemoryBoard();
	});

	// -- Forums ---------------------------------------------------------------

	it("creates and retrieves forums", () => {
		const forum = board.createForum("Test Forum");
		expect(forum.name).toBe("Test Forum");
		expect(board.getForum(forum.id)).toEqual(forum);
		expect(board.getForums()).toHaveLength(1);
	});

	// -- Topics ---------------------------------------------------------------

	it("creates topics within a forum", () => {
		const forum = board.createForum("F");
		const topic = board.createTopic(forum.id, "Auth Module");
		expect(topic.forumId).toBe(forum.id);
		expect(board.getTopics(forum.id)).toHaveLength(1);
	});

	it("rejects topic in non-existent forum", () => {
		expect(() => board.createTopic("fake", "T")).toThrow("Forum not found");
	});

	// -- Threads --------------------------------------------------------------

	it("creates threads within a topic", () => {
		const forum = board.createForum("F");
		const topic = board.createTopic(forum.id, "T");
		const thread = board.createThread(topic.id, "jade", "scout", "Analysis");
		expect(thread.agentColor).toBe("jade");
		expect(board.getThreads(topic.id)).toHaveLength(1);
	});

	it("creates sub-threads (recursive)", () => {
		const forum = board.createForum("F");
		const topic = board.createTopic(forum.id, "T");
		const parent = board.createThread(topic.id, "jade", "scout", "Parent");
		const child = board.createThread(topic.id, "fern", "scout", "Child", parent.id);
		expect(child.parentThreadId).toBe(parent.id);
		expect(board.getSubThreads(parent.id)).toHaveLength(1);
		// Top-level threads exclude sub-threads
		expect(board.getThreads(topic.id)).toHaveLength(1);
	});

	// -- Entries --------------------------------------------------------------

	it("appends entries as a linked list", () => {
		const forum = board.createForum("F");
		const topic = board.createTopic(forum.id, "T");
		const thread = board.createThread(topic.id, "denim", "worker");

		const e1 = board.appendEntry(thread.id, "denim", "text", "First message");
		const e2 = board.appendEntry(thread.id, "denim", "text", "Second message");
		const e3 = board.appendEntry(thread.id, "denim", "text", "Third message");

		expect(e1.parentId).toBeUndefined(); // first entry has no parent
		expect(e2.parentId).toBe(e1.id);
		expect(e3.parentId).toBe(e2.id);

		expect(board.getEntries(thread.id)).toHaveLength(3);
	});

	it("getEntriesByAgent filters by color", () => {
		const forum = board.createForum("F");
		const topic = board.createTopic(forum.id, "T");
		const t1 = board.createThread(topic.id, "jade", "scout");
		const t2 = board.createThread(topic.id, "ruby", "reviewer");

		board.appendEntry(t1.id, "jade", "text", "Scout report");
		board.appendEntry(t2.id, "ruby", "text", "Review notes");

		expect(board.getEntriesByAgent("jade")).toHaveLength(1);
		expect(board.getEntriesByAgent("ruby")).toHaveLength(1);
		expect(board.getEntriesByAgent("nonexistent")).toHaveLength(0);
	});

	// -- Edges ----------------------------------------------------------------

	it("creates typed edges between entries", () => {
		const forum = board.createForum("F");
		const topic = board.createTopic(forum.id, "T");
		const thread = board.createThread(topic.id, "denim", "worker");

		const e1 = board.appendEntry(thread.id, "denim", "text", "Finding");
		const e2 = board.appendEntry(thread.id, "denim", "text", "Based on finding");

		const edge = board.addEdge(e2.id, e1.id, "references");
		expect(edge.edgeType).toBe("references");
		expect(board.getEdgesFrom(e2.id)).toHaveLength(1);
		expect(board.getEdgesTo(e1.id)).toHaveLength(1);
	});

	// -- Contracts ------------------------------------------------------------

	it("stores and retrieves contracts", () => {
		const forum = board.createForum("F");
		const contract = {
			id: "c1",
			goal: "Refactor auth",
			forumId: forum.id,
			stages: [],
			breakpoints: [],
			status: "active" as const,
			createdAt: Date.now(),
		};
		board.setContract(contract);
		expect(board.getContract("c1")).toEqual(contract);
		expect(board.getActiveContract(forum.id)).toEqual(contract);
	});

	// -- Scope ----------------------------------------------------------------

	it("checkAccess defaults to open when no rules set", () => {
		const forum = board.createForum("F");
		const topic = board.createTopic(forum.id, "T");
		board.createThread(topic.id, "jade", "scout");

		expect(board.checkAccess("jade", "forum.topic.thread", "read")).toBe(true);
		expect(board.checkAccess("jade", "forum.topic.thread", "write")).toBe(true);
	});

	it("checkAccess enforces scope rules", () => {
		const forum = board.createForum("F");
		const topic = board.createTopic(forum.id, "T");
		board.createThread(topic.id, "jade", "scout");

		board.setScopeRules([{ agentRole: "scout", read: ["*"], write: ["forum.analysis.*"] }]);

		expect(board.checkAccess("jade", "forum.analysis.thread1", "write")).toBe(true);
		expect(board.checkAccess("jade", "forum.implementation.thread1", "write")).toBe(false);
		expect(board.checkAccess("jade", "forum.anything", "read")).toBe(true);
	});

	// -- Search ---------------------------------------------------------------

	it("search finds entries by content", () => {
		const forum = board.createForum("F");
		const topic = board.createTopic(forum.id, "T");
		const thread = board.createThread(topic.id, "denim", "worker");

		board.appendEntry(thread.id, "denim", "text", "JWT token validation");
		board.appendEntry(thread.id, "denim", "text", "Session middleware");
		board.appendEntry(thread.id, "denim", "text", "JWT refresh logic");

		expect(board.search("JWT")).toHaveLength(2);
		expect(board.search("middleware")).toHaveLength(1);
		expect(board.search("nonexistent")).toHaveLength(0);
	});
});

// ===========================================================================
// Scope matching
// ===========================================================================

describe("matchesScope", () => {
	it("wildcard matches everything", () => {
		expect(matchesScope(["*"], "any.path.here")).toBe(true);
	});

	it("exact match", () => {
		expect(matchesScope(["forum.topic.thread"], "forum.topic.thread")).toBe(true);
		expect(matchesScope(["forum.topic.thread"], "forum.topic.other")).toBe(false);
	});

	it("partial wildcard", () => {
		expect(matchesScope(["forum.*.thread"], "forum.topic.thread")).toBe(true);
		expect(matchesScope(["forum.*.thread"], "forum.other.thread")).toBe(true);
		expect(matchesScope(["forum.*.thread"], "forum.topic.nope")).toBe(false);
	});

	it("prefix match (shorter pattern)", () => {
		expect(matchesScope(["forum.topic"], "forum.topic.thread.sub")).toBe(true);
	});

	it("no match when pattern is longer than path", () => {
		expect(matchesScope(["forum.topic.thread.sub"], "forum.topic")).toBe(false);
	});

	it("empty patterns match nothing", () => {
		expect(matchesScope([], "any.path")).toBe(false);
	});
});
