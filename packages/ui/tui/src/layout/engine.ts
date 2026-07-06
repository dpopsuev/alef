import type { PanelSlot } from "./panel.js";

/**
 *
 */
export type SplitDirection = "vertical" | "horizontal";

/**
 *
 */
export interface LayoutNode {
	slots: PanelSlot[];
	direction: SplitDirection;
}

/**
 *
 */
export interface LayoutResult {
	panelId: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 *
 */
export function computeLayout(node: LayoutNode, width: number, height: number): LayoutResult[] {
	const visible = node.slots.filter((s) => s.panel.visible);
	if (visible.length === 0) return [];

	const totalFlex = visible.reduce((sum, s) => sum + s.flex, 0);
	const results: LayoutResult[] = [];

	if (node.direction === "vertical") {
		let y = 0;
		for (const slot of visible) {
			const slotHeight = Math.max(slot.minHeight ?? 1, Math.floor((slot.flex / totalFlex) * height));
			const clamped = slot.maxHeight ? Math.min(slotHeight, slot.maxHeight) : slotHeight;
			results.push({ panelId: slot.panel.id, x: 0, y, width, height: clamped });
			y += clamped;
		}
	} else {
		let x = 0;
		for (const slot of visible) {
			const slotWidth = Math.max(1, Math.floor((slot.flex / totalFlex) * width));
			results.push({ panelId: slot.panel.id, x, y: 0, width: slotWidth, height });
			x += slotWidth;
		}
	}

	return results;
}
