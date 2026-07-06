import type { Component } from "../component.js";
import { FlowEdge, type FlowEdgeOptions } from "./flow-edge.js";
import { FlowJunction, type FlowJunctionOptions } from "./flow-junction.js";
import { FlowLoop, type FlowLoopOptions } from "./flow-loop.js";
import { FlowNode, type FlowNodeOptions } from "./flow-node.js";

/**
 *
 */
export type FlowElement =
	| { type: "node"; node: FlowNodeOptions }
	| { type: "edge"; edge?: FlowEdgeOptions }
	| { type: "loop"; loop: FlowLoopOptions }
	| { type: "junction"; junction: FlowJunctionOptions };

/**
 *
 */
export interface FlowLayoutOptions {
	elements: FlowElement[];
	zoom?: 0 | 1 | 2 | 3;
	activeId?: string;
}

/**
 *
 */
export class FlowLayout implements Component {
	private elements: FlowElement[];
	private zoom: 0 | 1 | 2 | 3;
	private activeId: string | null;

	constructor(opts: FlowLayoutOptions) {
		this.elements = opts.elements;
		this.zoom = opts.zoom ?? 1;
		this.activeId = opts.activeId ?? null;
	}

	setElements(elements: FlowElement[]): void {
		this.elements = elements;
	}

	setZoom(zoom: 0 | 1 | 2 | 3): void {
		this.zoom = zoom;
	}

	setActive(id: string | null): void {
		this.activeId = id;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		for (const el of this.elements) {
			switch (el.type) {
				case "node": {
					const isActive = el.node.id === this.activeId;
					const collapsed = this.zoom === 0 ? true : isActive ? false : (el.node.collapsed ?? true);
					const node = new FlowNode({ ...el.node, collapsed });
					lines.push(...node.render(width));
					break;
				}
				case "edge": {
					const edge = new FlowEdge(el.edge);
					lines.push(...edge.render(width));
					break;
				}
				case "loop": {
					const loop = new FlowLoop(el.loop);
					lines.push(...loop.render(width));
					break;
				}
				case "junction": {
					const junction = new FlowJunction(el.junction);
					lines.push(...junction.render(width));
					break;
				}
			}
		}

		return lines;
	}
}
