import type { Component } from "../component.js";
import type { ThemeTokens } from "../theme-types.js";
import type { Container } from "../tui.js";
import { Collapsible } from "../components/collapsible.js";
import { Markdown } from "../components/markdown.js";
import { fmtMs } from "./ansi-utils.js";
import { AgentBlock } from "./chat-view.js";
import { makeMarkdownTheme, makeThinkingMarkdownTheme } from "./markdown-themes.js";
import { color } from "./theme.js";

/**
 * One streaming component per assistant turn.
 * Delegates label rendering to AgentBlock for visual consistency with user messages.
 * Opened on first chunk, closed in reset(), left in chat as history.
 */
export class ReplyBlock {
	private readonly block: AgentBlock;

	markdownNode: Markdown | null = null;
	thinkNode: Markdown | null = null;
	private thinkCollapsible: Collapsible | null = null;
	private thinkStartedAt = 0;
	private replyText = "";
	private thinkText = "";
	private _hideThinking: boolean;

	constructor(
		chat: Container,
		private readonly requestRender: () => void,
		private readonly t: ThemeTokens,
		hideThinking = true,
		agentLabel?: string,
	) {
		this._hideThinking = hideThinking;
		this.block = new AgentBlock(chat, t, agentLabel);
	}

	get hideThinking(): boolean {
		return this._hideThinking;
	}

	setHideThinking(hide: boolean): void {
		if (this._hideThinking === hide) return;
		this._hideThinking = hide;
		if (this.thinkCollapsible) {
			if (hide) this.thinkCollapsible.collapse();
			else this.thinkCollapsible.expand();
		}
		this.requestRender();
	}

	receiveText(chunk: string): void {
		if (!this.block.isOpen) this.block.start();
		if (!this.markdownNode) {
			this.markdownNode = new Markdown("", 0, 0, makeMarkdownTheme(this.t));
			this.block.addContent(this.markdownNode);
		}
		this.replyText += chunk;
		this.markdownNode.setText(this.replyText);
		this.requestRender();
	}

	receiveThinking(chunk: string): void {
		if (!this.block.isOpen) this.block.start();
		if (!this.thinkNode) {
			this.thinkStartedAt = Date.now();
			this.thinkNode = new Markdown("", 0, 0, makeThinkingMarkdownTheme(this.t));
			this.thinkCollapsible = new Collapsible({
				header: "thinking",
				collapsed: this._hideThinking,
				headerStyle: (s) => color(`┊ ${s}`, this.t.secondaryFg),
			});
			this.thinkCollapsible.setContent(this.thinkNode);
			this.block.addContent(this.thinkCollapsible);
		}
		this.thinkText += chunk;
		this.thinkNode.setText(this.thinkText);
		this.requestRender();
	}

	stampThinkingLabel(): void {
		if (this.thinkCollapsible && this.thinkStartedAt > 0) {
			const ms = Date.now() - this.thinkStartedAt;
			this.thinkCollapsible.setHeader(`thought for ${fmtMs(ms)}`);
			this.thinkStartedAt = 0;
		}
	}

	reset(): void {
		this.stampThinkingLabel();
		if (this.block.isOpen) this.block.end();
		this.markdownNode = null;
		this.thinkNode = null;
		this.thinkCollapsible = null;
		this.replyText = "";
		this.thinkText = "";
	}

	clear(): void {
		if (this.block.isOpen) this.block.end();
		this.markdownNode = null;
		this.thinkNode = null;
		this.thinkCollapsible = null;
		this.thinkStartedAt = 0;
		this.replyText = "";
		this.thinkText = "";
	}

	addToCurrentSegment(component: Component): void {
		this.block.addContent(component);
	}
}
