/**
 * Actor identity — palette, actor resolution, @ routing.
 *
 * Given/When/Then per describe block.
 */

import { resolveAgentActor, resolveHumanActor } from "@dpopsuev/alef-agent/identity/actor";
import { ALL_COLORS, hexToColorToken, lookupColor } from "@dpopsuev/alef-agent/identity/palette";
import { ActorRouteTable, parseAtAddress } from "@dpopsuev/alef-agent/identity/routes";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

describe("palette", { tags: ["unit"] }, () => {
	it("has 144 colors (12 families × 12)", () => {
		expect(ALL_COLORS.length).toBe(144);
	});

	it("all color names are lowercase single words with no dots", () => {
		for (const c of ALL_COLORS) {
			expect(c.name).toMatch(/^[a-z]+$/);
		}
	});

	it("all color names are unique", () => {
		const names = ALL_COLORS.map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("hexToColorToken produces a truecolor token from a hex string", () => {
		const token = hexToColorToken("#DC143C");
		expect(token.truecolor).toBe("#DC143C");
	});

	it("lookupColor finds a color by name and returns hex", () => {
		const c = lookupColor("crimson");
		expect(c).toBeDefined();
		expect(c?.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
	});

	it("lookupColor returns undefined for unknown names", () => {
		expect(lookupColor("notacolor")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Actor resolution
// ---------------------------------------------------------------------------

describe("resolveHumanActor", { tags: ["unit"] }, () => {
	it("type is 'human'", () => {
		const a = resolveHumanActor();
		expect(a.type).toBe("human");
	});

	it("address has @ prefix", () => {
		const a = resolveHumanActor();
		expect(a.address).toMatch(/^@/);
	});

	it("color is the OS username (non-empty string)", () => {
		const a = resolveHumanActor();
		expect(typeof a.color).toBe("string");
		expect(a.color.length).toBeGreaterThan(0);
	});
});

describe("resolveAgentActor", { tags: ["unit"] }, () => {
	it("type is 'agent'", () => {
		const a = resolveAgentActor("abc12345", "boardhash");
		expect(a.type).toBe("agent");
	});

	it("address has @ prefix", () => {
		const a = resolveAgentActor("abc12345", "boardhash");
		expect(a.address).toMatch(/^@/);
	});

	it("color is a known palette name", () => {
		const a = resolveAgentActor("abc12345", "boardhash");
		expect(lookupColor(a.color)).toBeDefined();
	});

	it("same sessionId always produces the same color (deterministic)", () => {
		const a1 = resolveAgentActor("sessionXYZ", "board1");
		const a2 = resolveAgentActor("sessionXYZ", "board1");
		expect(a1.color).toBe(a2.color);
	});

	it("different sessionIds produce different colors", () => {
		const colors = new Set(Array.from({ length: 20 }, (_, i) => resolveAgentActor(`session${i}`, "board").color));
		expect(colors.size).toBeGreaterThan(1);
	});

	it("hex matches the palette hex for the assigned color", () => {
		const a = resolveAgentActor("test-session", "test-board");
		const paletteEntry = lookupColor(a.color);
		expect(a.hex).toBe(paletteEntry?.hex);
	});
});

// ---------------------------------------------------------------------------
// @ routing
// ---------------------------------------------------------------------------

describe("parseAtAddress", { tags: ["unit"] }, () => {
	it("parses '@color message' into address and message", () => {
		const r = parseAtAddress("@crimson fix the signal bus");
		expect(r).not.toBeNull();
		expect(r?.address).toBe("crimson");
		expect(r?.message).toBe("fix the signal bus");
	});

	it("returns null for plain text (no @)", () => {
		expect(parseAtAddress("hello world")).toBeNull();
	});

	it("returns null for @ with no message body", () => {
		expect(parseAtAddress("@crimson")).toBeNull();
	});

	it("strips the address — message is the remainder only", () => {
		const r = parseAtAddress("@denim read ona.com and tell me what it does");
		expect(r?.message).toBe("read ona.com and tell me what it does");
	});

	it("supports FQDN addresses", () => {
		const r = parseAtAddress("@crimson.amber.a9a10682.4b6c8fcf what is the status?");
		expect(r?.address).toBe("crimson.amber.a9a10682.4b6c8fcf");
		expect(r?.message).toBe("what is the status?");
	});
});

describe("ActorRouteTable", { tags: ["unit"] }, () => {
	it("register and resolve a route", async () => {
		const table = new ActorRouteTable();
		let received = "";
		table.register("crimson", async (msg) => {
			received = msg;
		});
		await table.resolve("crimson")?.("hello", 5000);
		expect(received).toBe("hello");
	});

	it("resolve returns undefined for unknown address", () => {
		const table = new ActorRouteTable();
		expect(table.resolve("notregistered")).toBeUndefined();
	});

	it("addresses() lists all registered addresses", () => {
		const table = new ActorRouteTable();
		table.register("crimson", async () => {});
		table.register("denim", async () => {});
		expect(table.addresses()).toContain("crimson");
		expect(table.addresses()).toContain("denim");
	});

	it("unregister removes a route", () => {
		const table = new ActorRouteTable();
		table.register("crimson", async () => {});
		table.unregister("crimson");
		expect(table.resolve("crimson")).toBeUndefined();
	});

	it("isHumanAddress returns true for the human color", () => {
		const table = new ActorRouteTable();
		table.setHumanAddress("dpopsuev");
		expect(table.isHumanAddress("dpopsuev")).toBe(true);
		expect(table.isHumanAddress("crimson")).toBe(false);
	});
});
