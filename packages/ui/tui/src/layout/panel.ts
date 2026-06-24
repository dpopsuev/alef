import type { Component } from "../component.js";

export interface Panel extends Component {
	readonly id: string;
	readonly visible: boolean;
	setVisible(v: boolean): void;
	focus(): void;
	blur(): void;
	readonly focused: boolean;
}

export interface PanelSlot {
	panel: Panel;
	flex: number;
	minHeight?: number;
	maxHeight?: number;
	border?: "focus" | "always" | "none";
	group?: string;
}

export class FocusRing {
	private panels: Panel[] = [];
	private activeIndex = 0;

	register(panel: Panel): void {
		this.panels.push(panel);
		if (this.panels.length === 1) panel.focus();
	}

	unregister(panel: Panel): void {
		this.panels = this.panels.filter((p) => p.id !== panel.id);
	}

	cycle(): void {
		if (this.panels.length === 0) return;
		this.panels[this.activeIndex]?.blur();
		this.activeIndex = (this.activeIndex + 1) % this.panels.length;
		this.panels[this.activeIndex]?.focus();
	}

	get active(): Panel | null {
		return this.panels[this.activeIndex] ?? null;
	}
}
