import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	TruncatedText,
	truncateToWidth,
} from "@dpopsuev/alef-tui";
import type { ReviewComment, ReviewDocument, ReviewNode } from "../../../core/platform/types.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

interface FlatReviewNode {
	node: ReviewNode;
	indent: number;
	commentCount: number;
}

class ReviewBoardView implements Component {
	private flatNodes: FlatReviewNode[] = [];
	private selectedIndex = 0;

	public onCancel?: () => void;
	public onComment?: (nodeId: string, body: string) => void;

	private commentInput: Input | undefined;
	private commentingNodeId: string | undefined;

	constructor(
		private document: ReviewDocument,
		private readonly maxVisibleLines: number,
	) {
		this.rebuild();
	}

	setDocument(document: ReviewDocument): void {
		const currentSelection = this.flatNodes[this.selectedIndex]?.node.id;
		this.document = document;
		this.rebuild();
		if (currentSelection) {
			const nextIndex = this.flatNodes.findIndex((entry) => entry.node.id === currentSelection);
			if (nextIndex >= 0) {
				this.selectedIndex = nextIndex;
				return;
			}
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(this.flatNodes.length - 1, 0));
	}

	getSelectedNode(): ReviewNode | undefined {
		return this.flatNodes[this.selectedIndex]?.node;
	}

	invalidate(): void {}

	private rebuild(): void {
		const nodesByParent = new Map<string | undefined, ReviewNode[]>();
		for (const node of this.document.nodes) {
			const siblings = nodesByParent.get(node.parentId) ?? [];
			siblings.push(node);
			nodesByParent.set(node.parentId, siblings);
		}

		const commentCounts = new Map<string, number>();
		for (const comment of this.document.comments) {
			commentCounts.set(comment.nodeId, (commentCounts.get(comment.nodeId) ?? 0) + 1);
		}

		const flatNodes: FlatReviewNode[] = [];
		const visit = (parentId: string | undefined, indent: number) => {
			for (const node of nodesByParent.get(parentId) ?? []) {
				flatNodes.push({
					node,
					indent,
					commentCount: commentCounts.get(node.id) ?? 0,
				});
				visit(node.id, indent + 1);
			}
		};

		visit(undefined, 0);
		this.flatNodes = flatNodes;
	}

	private renderNodeLines(width: number): string[] {
		if (this.flatNodes.length === 0) {
			return [truncateToWidth(theme.fg("muted", "  No reviewable nodes in this document."), width)];
		}

		const lines: string[] = [];
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisibleLines / 2),
				Math.max(this.flatNodes.length - this.maxVisibleLines, 0),
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisibleLines, this.flatNodes.length);

		for (let index = startIndex; index < endIndex; index += 1) {
			const entry = this.flatNodes[index];
			const isSelected = index === this.selectedIndex;
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const indent = "  ".repeat(entry.indent);
			const kind = theme.fg("muted", `[${entry.node.kind}]`);
			const status = entry.node.status ? theme.fg("muted", ` ${entry.node.status}`) : "";
			const comments = entry.commentCount > 0 ? theme.fg("warning", ` (+${entry.commentCount})`) : "";
			let line = `${cursor}${indent}${kind} ${entry.node.title}${status}${comments}`;
			if (isSelected) {
				line = theme.bg("selectedBg", theme.bold(line));
			}
			lines.push(truncateToWidth(line, width));
		}

		return lines;
	}

	private renderCommentsForNode(nodeId: string): ReviewComment[] {
		return this.document.comments
			.filter((comment) => comment.nodeId === nodeId)
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	private renderDetailLines(width: number): string[] {
		const node = this.getSelectedNode();
		if (!node) {
			return [truncateToWidth(theme.fg("muted", "  Select a review node to inspect it."), width)];
		}

		const lines: string[] = [];
		lines.push(truncateToWidth(`  ${theme.bold(node.title)}`, width));

		const meta = [node.kind, node.status].filter(Boolean).join(" · ");
		if (meta) {
			lines.push(truncateToWidth(`  ${theme.fg("muted", meta)}`, width));
		}

		if (node.summary) {
			lines.push(truncateToWidth(`  ${node.summary}`, width));
		}

		if (node.body) {
			for (const line of node.body.split("\n").slice(0, 6)) {
				lines.push(truncateToWidth(`  ${theme.fg("dim", line)}`, width));
			}
			if (node.body.split("\n").length > 6) {
				lines.push(truncateToWidth(`  ${theme.fg("muted", "...")}`, width));
			}
		}

		if (node.fields.length > 0) {
			lines.push(truncateToWidth(`  ${theme.fg("accent", "Fields")}`, width));
			for (const field of node.fields) {
				lines.push(truncateToWidth(`    ${theme.fg("muted", `${field.key}:`)} ${field.value}`, width));
			}
		}

		if (node.actions.length > 0) {
			lines.push(truncateToWidth(`  ${theme.fg("accent", "Actions")}`, width));
			for (const action of node.actions) {
				const state = action.enabled ? "" : theme.fg("muted", " (disabled)");
				lines.push(truncateToWidth(`    ${action.label}${state}`, width));
			}
		}

		const comments = this.renderCommentsForNode(node.id);
		lines.push(truncateToWidth(`  ${theme.fg("accent", "Comments")}`, width));
		if (comments.length === 0) {
			lines.push(truncateToWidth(`    ${theme.fg("muted", "No comments yet. Press Enter to add one.")}`, width));
		} else {
			for (const comment of comments.slice(-4)) {
				lines.push(
					truncateToWidth(
						`    ${theme.fg("warning", comment.author)} ${theme.fg("muted", new Date(comment.createdAt).toLocaleString())}`,
						width,
					),
				);
				for (const line of comment.body.split("\n").slice(0, 2)) {
					lines.push(truncateToWidth(`      ${line}`, width));
				}
			}
		}

		if (this.commentInput && this.commentingNodeId === node.id) {
			lines.push(truncateToWidth(`  ${theme.fg("accent", "Add comment")}`, width));
			for (const line of this.commentInput.render(Math.max(width - 4, 10))) {
				lines.push(truncateToWidth(`    ${line}`, width));
			}
			lines.push(
				truncateToWidth(
					`    ${theme.fg("muted", `${keyHint("tui.select.confirm", "save")}  ${keyHint("tui.select.cancel", "cancel")}`)}`,
					width,
				),
			);
		}

		return lines;
	}

	private beginComment(): void {
		const node = this.getSelectedNode();
		if (!node) {
			return;
		}
		this.commentingNodeId = node.id;
		this.commentInput = new Input();
	}

	private submitComment(): void {
		if (!this.commentInput || !this.commentingNodeId) {
			return;
		}
		const body = this.commentInput.getValue().trim();
		if (!body) {
			this.commentInput = undefined;
			this.commentingNodeId = undefined;
			return;
		}
		this.onComment?.(this.commentingNodeId, body);
		this.commentInput = undefined;
		this.commentingNodeId = undefined;
	}

	private cancelComment(): void {
		this.commentInput = undefined;
		this.commentingNodeId = undefined;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(truncateToWidth(`  ${theme.fg("accent", this.document.title)}`, width));
		if (this.document.description) {
			lines.push(truncateToWidth(`  ${theme.fg("muted", this.document.description)}`, width));
		}
		lines.push(truncateToWidth(`  ${theme.fg("accent", "Nodes")}`, width));
		lines.push(...this.renderNodeLines(width));
		lines.push(truncateToWidth(`  ${theme.fg("accent", "Detail")}`, width));
		lines.push(...this.renderDetailLines(width));
		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (this.commentInput) {
			if (kb.matches(keyData, "tui.select.confirm")) {
				this.submitComment();
			} else if (kb.matches(keyData, "tui.select.cancel")) {
				this.cancelComment();
			} else {
				this.commentInput.handleInput(keyData);
			}
			return;
		}

		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex =
				this.selectedIndex === 0 ? Math.max(this.flatNodes.length - 1, 0) : this.selectedIndex - 1;
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex =
				this.selectedIndex >= this.flatNodes.length - 1
					? 0
					: Math.min(this.selectedIndex + 1, this.flatNodes.length - 1);
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisibleLines);
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.flatNodes.length - 1, this.selectedIndex + this.maxVisibleLines);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.beginComment();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		}
	}
}

export class ReviewBoardComponent extends Container implements Focusable {
	private readonly view: ReviewBoardView;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		document: ReviewDocument,
		terminalHeight: number,
		onComment: (nodeId: string, body: string) => void,
		onCancel: () => void,
	) {
		super();
		this.view = new ReviewBoardView(document, Math.max(6, Math.floor(terminalHeight / 3)));
		this.view.onComment = onComment;
		this.view.onCancel = onCancel;

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold("  Review Board"), 1, 0));
		this.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					`  ${keyHint("tui.select.up", "move")}  ${keyHint("tui.select.down", "move")}  ${keyHint("tui.select.confirm", "comment")}  ${keyHint("tui.select.cancel", "close")}`,
				),
				0,
				0,
			),
		);
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.view);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	setDocument(document: ReviewDocument): void {
		this.view.setDocument(document);
	}

	getSelectedNode(): ReviewNode | undefined {
		return this.view.getSelectedNode();
	}

	handleInput(keyData: string): void {
		this.view.handleInput(keyData);
	}
}
