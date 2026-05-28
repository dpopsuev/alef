import { Box, type Component, type Container, Markdown, Text } from "@dpopsuev/alef-tui";
import type { ThemeTokens } from "../theme.js";
import { boldColor } from "../theme.js";
import { DynamicText } from "./dynamic-text.js";
import { makeMarkdownTheme, makeThinkingMarkdownTheme } from "./markdown-themes.js";
import { color, dim } from "./theme.js";

const AGENT_LABEL = process.env.ALEF_AGENT_LABEL ?? "@alef";

/**
 * One streaming component per assistant turn — pi-mono AssistantMessageComponent pattern.
 * Created on first chunk, updated in place, left in chat as history when the turn ends.
 * Header added at wrapper creation; footer stamped in reset().
 */
export class StreamingZone {
	private wrapper: Box | null = null;

	markdownNode: Markdown | null = null;
	thinkNode: Markdown | null = null;
	private thinkHeader: Text | null = null;
	private thinkStartedAt = 0;
	private replyText = "";
	private thinkText = "";
	private _hideThinking: boolean;

	constructor(
		private readonly chat: Container,
		private readonly requestRender: () => void,
		private readonly t: ThemeTokens,
		hideThinking = true,
	) {
		this._hideThinking = hideThinking;
	}

	get hideThinking(): boolean {
		return this._hideThinking;
	}

	setHideThinking(hide: boolean): void {
		if (this._hideThinking === hide) return;
		this._hideThinking = hide;
		if (this.wrapper && this.thinkNode) {
			this.wrapper.clear();
			if (this.thinkHeader) this.wrapper.addChild(this.thinkHeader);
			if (!hide) this.wrapper.addChild(this.thinkNode);
			if (this.markdownNode) this.wrapper.addChild(this.markdownNode);
		}
		this.requestRender();
	}

	private ensureWrapper(): Box {
		if (!this.wrapper) {
			const { accentFg } = this.t;
			this.wrapper = new Box(1, 0);
			this.chat.addChild(this.wrapper);
			this.wrapper.addChild(new Text(boldColor(AGENT_LABEL, accentFg), 0, 0));
		}
		return this.wrapper;
	}

	receiveText(chunk: string): void {
		const w = this.ensureWrapper();
		if (!this.markdownNode) {
			this.markdownNode = new Markdown("", 0, 0, makeMarkdownTheme(this.t));
			w.addChild(this.markdownNode);
		}
		this.replyText += chunk;
		this.markdownNode.setText(this.replyText);
		this.requestRender();
	}

	receiveThinking(chunk: string): void {
		const w = this.ensureWrapper();
		if (!this.thinkNode) {
			this.thinkStartedAt = Date.now();
			this.thinkHeader = new Text(color(dim("┊ thinking"), this.t.dimFg), 0, 0);
			w.addChild(this.thinkHeader);
			this.thinkNode = new Markdown("", 0, 0, makeThinkingMarkdownTheme(this.t));
			if (!this._hideThinking) w.addChild(this.thinkNode);
		}
		this.thinkText += chunk;
		this.thinkNode.setText(this.thinkText);
		if (!this._hideThinking) this.requestRender();
	}

	/** Stamp the thinking elapsed label. Call when thinking ends (tool start or turn end). */
	stampThinkingLabel(): void {
		if (this.thinkHeader && this.thinkStartedAt > 0) {
			const ms = Date.now() - this.thinkStartedAt;
			const elapsed = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
			this.thinkHeader.setText(color(dim(`┈ thought for ${elapsed}`), this.t.dimFg));
			this.thinkStartedAt = 0;
		}
	}

	/** Reset for a new turn. Stamps thinking label and footer, leaves content in chat. */
	reset(): void {
		this.stampThinkingLabel();
		if (this.wrapper) {
			const { accentFg } = this.t;
			this.chat.addChild(new DynamicText((w) => color("─".repeat(w), accentFg)));
		}
		this.wrapper = null;
		this.markdownNode = null;
		this.thinkNode = null;
		this.thinkHeader = null;
		this.replyText = "";
		this.thinkText = "";
	}

	/** Remove current turn's content. Abort path only. */
	clear(): void {
		if (this.wrapper) {
			this.chat.removeChild(this.wrapper);
			this.wrapper = null;
		}
		this.markdownNode = null;
		this.thinkNode = null;
		this.thinkHeader = null;
		this.thinkStartedAt = 0;
		this.replyText = "";
		this.thinkText = "";
	}

	addToCurrentSegment(component: Component): void {
		if (this.wrapper) {
			this.wrapper.addChild(component);
		} else {
			this.chat.addChild(component);
		}
	}
}
