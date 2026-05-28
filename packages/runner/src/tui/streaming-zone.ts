import { Box, type Component, type Container, Markdown, Text } from "@dpopsuev/alef-tui";
import type { ThemeTokens } from "../theme.js";
import { makeMarkdownTheme, makeThinkingMarkdownTheme } from "./markdown-themes.js";
import { color, dim } from "./theme.js";

/**
 * Streaming content for one assistant turn.
 *
 * No pill borders. One Container per segment (text between tool calls),
 * appended to chat lazily on first chunk. Tool blocks added by the caller
 * interleave naturally between containers. pi-mono AssistantMessageComponent
 * is the prior art: one component per message, updated in place.
 *
 * Segment lifecycle: receiveText/receiveThinking accumulate into the active
 * wrapper. seal() closes it and nulls the pointer so the next chunk creates
 * a fresh wrapper (appended after any tool blocks). clear() removes all
 * wrappers (abort path).
 */
export class StreamingZone {
	/** Active wrapper container. null between segments. */
	private wrapper: Container | null = null;
	/** All wrappers ever added — used by clear() to remove them. */
	private readonly allWrappers: Box[] = [];

	/** Exposed for tests. */
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
		private readonly trace: (event: string, data?: Record<string, unknown>) => void = () => {},
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

	private ensureWrapper(): Container {
		if (!this.wrapper) {
			const w = new Box(1, 0);
			this.allWrappers.push(w);
			this.chat.addChild(w);
			this.wrapper = w;
		}
		return this.wrapper;
	}

	receiveText(chunk: string): void {
		const w = this.ensureWrapper();
		if (!this.markdownNode) {
			this.markdownNode = new Markdown("", 0, 0, makeMarkdownTheme(this.t));
			w.addChild(this.markdownNode);
			this.trace("receiveText:first");
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

	seal(): void {
		if (this.thinkHeader && this.thinkStartedAt > 0) {
			const ms = Date.now() - this.thinkStartedAt;
			const elapsed = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
			this.thinkHeader.setText(color(dim(`┈ thought for ${elapsed}`), this.t.dimFg));
			this.thinkStartedAt = 0;
		}
		this.wrapper = null;
		this.markdownNode = null;
		this.thinkNode = null;
		this.thinkHeader = null;
		this.replyText = "";
		this.thinkText = "";
	}

	clear(): void {
		for (const w of this.allWrappers) this.chat.removeChild(w);
		this.allWrappers.length = 0;
		this.wrapper = null;
		this.markdownNode = null;
		this.thinkNode = null;
		this.thinkHeader = null;
		this.thinkStartedAt = 0;
		this.replyText = "";
		this.thinkText = "";
	}

	/** Add a component to the active wrapper, or directly to chat if none is open. */
	addToCurrentSegment(component: Component): void {
		if (this.wrapper) {
			this.wrapper.addChild(component);
		} else {
			this.chat.addChild(component);
		}
	}
}
