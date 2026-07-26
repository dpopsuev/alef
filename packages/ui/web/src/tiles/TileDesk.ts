import "dockview/dist/styles/dockview.css";
import {
	DockviewComponent,
	type IContentRenderer,
	type IGroupPanelInitParameters,
	type PanelUpdateEvent,
	type Parameters,
} from "dockview";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { TileInstance } from "./contracts.js";
import { parseTileDefinition } from "./contracts.js";
import { MetricTile } from "./MetricTile.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTileInstance(input: unknown): TileInstance {
	if (!isRecord(input)) throw new Error("invalid tile instance");
	return { definition: parseTileDefinition(input.definition), data: input.data };
}

class MetricTilePanel implements IContentRenderer {
	private readonly tile = new MetricTile();

	get element(): HTMLElement {
		return this.tile;
	}

	init(parameters: IGroupPanelInitParameters): void {
		this.updateTile(parameters.params.tile);
	}

	update(event: PanelUpdateEvent<Parameters>): void {
		this.updateTile(event.params.tile);
	}

	private updateTile(input: unknown): void {
		const instance = parseTileInstance(input);
		this.tile.definition = instance.definition;
		this.tile.data = instance.data;
	}
}

@customElement("alef-tile-desk")
export class TileDesk extends LitElement {
	@property({ attribute: false }) tiles: readonly TileInstance[] = [];
	private dockview?: DockviewComponent;

	override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override firstUpdated(): void {
		const container = this.querySelector<HTMLElement>("[data-tile-desk]");
		if (!container) throw new Error("tile desk container missing");
		this.dockview = new DockviewComponent(container, {
			keyboardNavigation: true,
			createComponent: ({ name }) => {
				if (name === "metric-grid") return new MetricTilePanel();
				throw new Error(`unknown tile component: ${name}`);
			},
		});
		this.syncTiles();
	}

	override updated(changed: Map<PropertyKey, unknown>): void {
		if (changed.has("tiles")) this.syncTiles();
	}

	private syncTiles(): void {
		if (!this.dockview) return;
		this.dockview.clear();
		this.tiles.forEach((tile, index) => {
			this.dockview?.addPanel({
				id: tile.definition.id,
				component: tile.definition.component,
				title: tile.definition.title,
				params: { tile },
				...(index === 0
					? {}
					: { position: { direction: "right" as const, referencePanel: this.tiles[0]?.definition.id } }),
			});
		});
	}

	override disconnectedCallback(): void {
		this.dockview?.dispose();
		this.dockview = undefined;
		super.disconnectedCallback();
	}

	override render() {
		return html`<div data-tile-desk class="dockview-theme-abyss h-full min-h-0 w-full"></div>`;
	}
}
