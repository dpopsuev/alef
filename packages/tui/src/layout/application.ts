import type { Component } from "../component.js";
import { computeLayout, type LayoutNode } from "./engine.js";
import { FocusManager } from "./panel.js";
import { type ViewDefinition, type ViewMode, ViewRouter } from "./view-router.js";

export interface ApplicationOptions {
	views: Partial<Record<ViewMode, ViewDefinition>>;
	initialView?: ViewMode;
}

export class Application implements Component {
	readonly router: ViewRouter;
	readonly focus: FocusManager;
	private width = 80;
	private height = 24;

	constructor(opts: ApplicationOptions) {
		this.router = new ViewRouter();
		this.focus = new FocusManager();

		for (const [mode, def] of Object.entries(opts.views)) {
			this.router.register(mode as ViewMode, def as ViewDefinition);
			for (const slot of (def as ViewDefinition).slots) {
				this.focus.register(slot.panel);
			}
		}

		this.router.switchTo(opts.initialView ?? "conversation");
	}

	handleInput(data: string): boolean {
		if (data === "\t") {
			this.focus.cycle();
			return true;
		}
		const active = this.focus.active;
		if (active?.handleInput) {
			active.handleInput(data);
			return true;
		}
		return false;
	}

	invalidate(): void {
		for (const slot of this.router.currentSlots) {
			slot.panel.invalidate?.();
		}
	}

	render(width: number): string[] {
		this.width = width;
		const slots = this.router.currentSlots;
		const layout: LayoutNode = { slots, direction: "vertical" };
		const regions = computeLayout(layout, width, this.height);

		const lines: string[] = [];
		for (const region of regions) {
			const slot = slots.find((s) => s.panel.id === region.panelId);
			if (!slot) continue;
			const panelLines = slot.panel.render(region.width);
			for (let i = 0; i < region.height && i < panelLines.length; i++) {
				lines.push(panelLines[i]);
			}
		}
		return lines;
	}

	setSize(width: number, height: number): void {
		this.width = width;
		this.height = height;
	}

	switchView(mode: ViewMode): void {
		this.router.switchTo(mode);
	}

	get currentView(): ViewMode {
		return this.router.current;
	}
}
