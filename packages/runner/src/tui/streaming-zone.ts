import { type Component, type Container, Markdown, Text } from "@dpopsuev/alef-tui";
import type { ThemeTokens } from "../theme.js";
import { fmtMs } from "./ansi-utils.js";
import { AgentBlock } from "./chat-view.js";
import { makeMarkdownTheme, makeThinkingMarkdownTheme } from "./markdown-themes.js";
import { color, dim } from "./theme.js";

/**
 * One streaming component per assistant turn.
 * Delegates pill header/footer to AgentBlock for visual consistency with user messages.
 * Opened on first chunk, closed in reset(), left in chat as history.
 */
export class StreamingZone {
	private readonly block: AgentBlock;

	markdownNode: Markdown | null = null;
	thinkNode: Markdown | null = null;
	private thinkHeader: Text | null = null;
	private thinkStartedAt = 0;
	private replyText = "";
	private thinkText = "";
	private _hideThinking: boolean;

	constructor(
		chat: Container,
		private readonly requestRender: () => void,
		private readonly t: ThemeTokens,
		hideThinking = true,
	) {
		this._hideThinking = hideThinking;
		this.block = new AgentBlock(chat, t);
	}

	get hideThinking(): boolean {
		return this._hideThinking;
	}

	setHideThinking(hide: boolean): void {
		if (this._hideThinking === hide) return;
		this._hideThinking = hide;
		if (this.block.isOpen && this.thinkNode) {
			if (hide) {
				this.block.removeContent(this.thinkNode);
			} else {
				if (this.markdownNode) this.block.removeContent(this.markdownNode);
				this.block.addContent(this.thinkNode);
				if (this.markdownNode) this.block.addContent(this.markdownNode);
			}
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
			this.thinkHeader = new Text(color(dim("┊ thinking"), this.t.dimFg), 0, 0);
			this.block.addContent(this.thinkHeader);
			this.thinkNode = new Markdown("", 0, 0, makeThinkingMarkdownTheme(this.t));
			if (!this._hideThinking) this.block.addContent(this.thinkNode);
		}
		this.thinkText += chunk;
		this.thinkNode.setText(this.thinkText);
		if (!this._hideThinking) this.requestRender();
	}

	stampThinkingLabel(): void {
		if (this.thinkHeader && this.thinkStartedAt > 0) {
			const ms = Date.now() - this.thinkStartedAt;
			const elapsed = fmtMs(ms);
			this.thinkHeader.setText(color(dim(`┈ thought for ${elapsed}`), this.t.dimFg));
			this.thinkStartedAt = 0;
		}
	}

	reset(): void {
		this.stampThinkingLabel();
		if (this.block.isOpen) this.block.end();
		this.markdownNode = null;
		this.thinkNode = null;
		this.thinkHeader = null;
		this.replyText = "";
		this.thinkText = "";
	}

	clear(): void {
		if (this.block.isOpen) this.block.end();
		this.markdownNode = null;
		this.thinkNode = null;
		this.thinkHeader = null;
		this.thinkStartedAt = 0;
		this.replyText = "";
		this.thinkText = "";
	}

	addToCurrentSegment(component: Component): void {
		this.block.addContent(component);
	}
}
