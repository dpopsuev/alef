import type { PanelSlot } from "./panel.js";

/**
 *
 */
export type ViewMode = "conversation" | "plan" | "agents" | "debug" | "dashboard";

/**
 *
 */
export interface ViewDefinition {
	slots: PanelSlot[];
}

/**
 *
 */
export class ViewRouter {
	private views = new Map<ViewMode, ViewDefinition>();
	private active: ViewMode = "conversation";
	private onChange?: (mode: ViewMode) => void;

	register(mode: ViewMode, definition: ViewDefinition): void {
		this.views.set(mode, definition);
	}

	switchTo(mode: ViewMode): void {
		if (!this.views.has(mode)) return;
		const prev = this.views.get(this.active);
		if (prev) for (const slot of prev.slots) slot.panel.setVisible(false);
		this.active = mode;
		const next = this.views.get(mode);
		if (next) for (const slot of next.slots) slot.panel.setVisible(true);
		this.onChange?.(mode);
	}

	get current(): ViewMode {
		return this.active;
	}

	get currentSlots(): PanelSlot[] {
		return this.views.get(this.active)?.slots ?? [];
	}

	setOnChange(fn: (mode: ViewMode) => void): void {
		this.onChange = fn;
	}

	modes(): ViewMode[] {
		return [...this.views.keys()];
	}
}
