import type { Component } from "../component.js";
import { TREE } from "../design/chars.js";

export interface TreeNode {
	label: string;
	component?: Component;
	children?: TreeNode[];
	collapsed?: boolean;
	style?: (s: string) => string;
}

export interface TreeViewOptions {
	nodes: TreeNode[];
	defaultStyle?: (s: string) => string;
}

export class TreeView implements Component {
	private nodes: TreeNode[];
	private defaultStyle: (s: string) => string;

	constructor(opts: TreeViewOptions) {
		this.nodes = opts.nodes;
		this.defaultStyle = opts.defaultStyle ?? ((s) => s);
	}

	setNodes(nodes: TreeNode[]): void {
		this.nodes = nodes;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const renderNode = (node: TreeNode, prefix: string, isLast: boolean): void => {
			const branch = isLast ? TREE.last : TREE.branch;
			const style = node.style ?? this.defaultStyle;
			lines.push(style(`${prefix}${branch}${node.label}`));
			if (node.component && !node.collapsed) {
				const contentPrefix = prefix + (isLast ? TREE.space : TREE.pipe);
				const contentWidth = Math.max(10, width - contentPrefix.length);
				for (const line of node.component.render(contentWidth)) {
					lines.push(`${contentPrefix}  ${line}`);
				}
			}
			if (node.collapsed || !node.children?.length) return;
			const childPrefix = prefix + (isLast ? TREE.space : TREE.pipe);
			for (let i = 0; i < node.children.length; i++) {
				renderNode(node.children[i], childPrefix, i === node.children.length - 1);
			}
		};
		for (let i = 0; i < this.nodes.length; i++) {
			renderNode(this.nodes[i], "", i === this.nodes.length - 1);
		}
		return lines;
	}
}
