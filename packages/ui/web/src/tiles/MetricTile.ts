import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { TileDefinition } from "./contracts.js";
import { resolveTileMetrics } from "./contracts.js";

function formatValue(value: string | number, format: "number" | "currency" | "percent" | "duration"): string {
	if (typeof value === "string") return value;
	if (format === "currency")
		return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value);
	if (format === "percent") return `${value.toFixed(1)}%`;
	if (format === "duration") return `${Math.round(value)} ms`;
	return new Intl.NumberFormat().format(value);
}

@customElement("alef-metric-tile")
export class MetricTile extends LitElement {
	@property({ attribute: false }) definition?: TileDefinition;
	@property({ attribute: false }) data: unknown;

	override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override render() {
		if (!this.definition) return html`<div class="p-4 text-muted-foreground">No tile definition</div>`;
		try {
			const metrics = resolveTileMetrics(this.definition, this.data);
			return html`
				<section class="h-full overflow-auto bg-background p-4" aria-label=${this.definition.title}>
					<div class="grid grid-cols-2 gap-3">
						${metrics.map(
							(metric) => html`
								<div class="rounded-lg border border-input bg-muted/30 p-3">
									<div class="text-xs text-muted-foreground">${metric.label}</div>
									<div class="mt-1 text-xl font-semibold tabular-nums">
										${formatValue(metric.value, metric.format)}
									</div>
								</div>
							`,
						)}
					</div>
				</section>
			`;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return html`<div class="p-4 text-destructive">${message}</div>`;
		}
	}
}
