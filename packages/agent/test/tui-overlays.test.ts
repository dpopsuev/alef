/**
 * Declarative overlay unit tests.
 * Verifies syncOverlays reconciles TUI child list from state transitions.
 */

import type { Component } from "@dpopsuev/alef-tui";
import { describe, expect, it, vi } from "vitest";
import type { OverlayDescriptor } from "../src/cli/tui-state.js";
import { syncOverlays } from "../src/cli/tui-state.js";

function makeComponent(id: string): Component {
	return { id } as unknown as Component;
}

function makeTui() {
	return { addChild: vi.fn(), removeChild: vi.fn() };
}

describe("syncOverlays", { tags: ["unit"] }, () => {
	it("adds components that appear in next but not prev", () => {
		const tui = makeTui();
		const overlay: OverlayDescriptor = { id: "picker", component: makeComponent("picker") };
		syncOverlays(tui, [], [overlay]);
		expect(tui.addChild).toHaveBeenCalledWith(overlay.component);
		expect(tui.removeChild).not.toHaveBeenCalled();
	});

	it("removes components that disappear from prev to next", () => {
		const tui = makeTui();
		const overlay: OverlayDescriptor = { id: "picker", component: makeComponent("picker") };
		syncOverlays(tui, [overlay], []);
		expect(tui.removeChild).toHaveBeenCalledWith(overlay.component);
		expect(tui.addChild).not.toHaveBeenCalled();
	});

	it("is idempotent — does not re-add unchanged overlays", () => {
		const tui = makeTui();
		const overlay: OverlayDescriptor = { id: "picker", component: makeComponent("picker") };
		syncOverlays(tui, [overlay], [overlay]);
		expect(tui.addChild).not.toHaveBeenCalled();
		expect(tui.removeChild).not.toHaveBeenCalled();
	});

	it("handles add + remove in the same transition", () => {
		const tui = makeTui();
		const a: OverlayDescriptor = { id: "a", component: makeComponent("a") };
		const b: OverlayDescriptor = { id: "b", component: makeComponent("b") };
		syncOverlays(tui, [a], [b]);
		expect(tui.removeChild).toHaveBeenCalledWith(a.component);
		expect(tui.addChild).toHaveBeenCalledWith(b.component);
	});

	it("empty to empty is a no-op", () => {
		const tui = makeTui();
		syncOverlays(tui, [], []);
		expect(tui.addChild).not.toHaveBeenCalled();
		expect(tui.removeChild).not.toHaveBeenCalled();
	});
});
