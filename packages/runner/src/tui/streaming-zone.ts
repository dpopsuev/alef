/**
 * StreamingZone — manages streaming content segments as standalone pill blocks.
 *
 * Each LLM generation phase (pre-tool text, post-tool text, thinking) gets its
 * own pill — header + Box(content) + footer — added directly to the chat
 * Container as siblings. No outer @alef wrapper: each block is independent.
 *
 * Layout per turn (example with thinking + 2 tools + reply):
 *
 *   ╭─ @alef ────────────────────╮  ← openSegment (text/thinking phase)
 *     ┈ thought for 2.3s
 *     [thinking content]
 *   ╰────────────────────────────╯  ← seal
 *
 *   ╭─ ✓ fs.read  path  50ms ────╮  ← appendCompletedToolBlock (sibling)
 *     [output]
 *   ╰────────────────────────────╯
 *
 *   ╭─ @alef ────────────────────╮  ← new openSegment (reply text phase)
 *     [reply text]
 *   ╰────────────────────────────╯  ← seal
 */

import { Box, type Component, type Container, Markdown, Spacer, Text } from "@dpopsuev/alef-tui";
import type { ThemeTokens } from "../theme.js";
import { DynamicText } from "./dynamic-text.js";
import { INDENT, SPACING } from "./layout-constants.js";
import { makeMarkdownTheme, makeThinkingMarkdownTheme } from "./markdown-themes.js";
import { pillFooterStr, pillHeaderStr } from "./pill.js";
import { bg, color, dim } from "./theme.js";
import { Typewriter } from "./typewriter.js";

const AGENT_LABEL = process.env.ALEF_AGENT_LABEL ?? "@alef";

/** Children added to chat for one segment — tracked for clear(). */
interface SegmentEntry {
	spacer: Spacer;
	header: DynamicText;
	box: Box;
	footer: DynamicText | null;
}

export class StreamingZone {
	/** Exposed for testing only. */
	readonly segments: Container[] = [];
	activeSegment: Container | null = null;
	markdownNode: Markdown | null = null;
	thinkNode: Markdown | null = null;
	private thinkHeaderNode: Text | null = null;

	private thinkingStartedAt = 0;
	private _chunksReceived = 0;
	private _hideThinking: boolean;
	private readonly requestRender: () => void;
	private readonly entries: SegmentEntry[] = [];

	readonly replyTypewriter: Typewriter;
	readonly thinkTypewriter: Typewriter;

	constructor(
		private readonly chat: Container,
		requestRender: () => void,
		private readonly t: ThemeTokens,
		private readonly trace: (event: string, data?: Record<string, unknown>) => void = () => {},
		hideThinking = true,
	) {
		this._hideThinking = hideThinking;
		this.requestRender = requestRender;
		this.replyTypewriter = new Typewriter({ setText: (text) => this.markdownNode?.setText(text) }, requestRender);
		this.thinkTypewriter = new Typewriter({ setText: (text) => this.thinkNode?.setText(text) }, requestRender);
	}

	get hideThinking(): boolean {
		return this._hideThinking;
	}

	/** True while a segment is open (receiving content). */
	get isOpen(): boolean {
		return this.activeSegment !== null;
	}

	setHideThinking(hide: boolean): void {
		if (this._hideThinking === hide) return;
		this._hideThinking = hide;
		if (this.thinkNode) {
			this.thinkTypewriter.flush();
			if (hide) {
				this.activeSegment?.removeChild(this.thinkNode);
			} else {
				this.activeSegment?.addChild(this.thinkNode);
			}
		}
		this.requestRender();
	}

	// ---------------------------------------------------------------------------
	// Segment lifecycle
	// ---------------------------------------------------------------------------

	private openSegment(): Container {
		if (!this.activeSegment) {
			const { agentFg, agentBg } = this.t;
			const hasBg = agentBg.truecolor !== undefined || agentBg.ansi256 !== undefined || agentBg.ansi16 !== undefined;
			const bgFn = hasBg ? (s: string) => bg(s, agentBg) : null;

			const spacer = new Spacer(SPACING.BETWEEN_BLOCKS);
			const header = new DynamicText((w) =>
				bgFn ? bgFn(color(pillHeaderStr(AGENT_LABEL, w), agentFg)) : color(pillHeaderStr(AGENT_LABEL, w), agentFg),
			);
			const box = bgFn ? new Box(INDENT.BLOCK, 0, bgFn) : new Box(INDENT.BLOCK, 0);

			this.chat.addChild(spacer);
			this.chat.addChild(header);
			this.chat.addChild(box);

			this.segments.push(box);
			this.entries.push({ spacer, header, box, footer: null });
			this.activeSegment = box;
		}
		return this.activeSegment;
	}

	/** Freeze the active segment: flush typewriters, add pill footer. */
	seal(): void {
		this.trace("sealStreamingSegment", {
			chunks: this._chunksReceived,
			markdownNode: this.markdownNode !== null,
			pending: this.replyTypewriter.pendingText.length,
		});
		this._chunksReceived = 0;

		this.replyTypewriter.flush();
		this.replyTypewriter.reset();
		this.thinkTypewriter.flush();
		this.thinkTypewriter.reset();

		if (this.thinkHeaderNode && this.thinkingStartedAt > 0) {
			const elapsedMs = Date.now() - this.thinkingStartedAt;
			const elapsedStr = elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`;
			const label = elapsedMs > 0 ? `┈ thought for ${elapsedStr}` : "┈ thought";
			this.thinkHeaderNode.setText(color(dim(label), this.t.dimFg));
			this.thinkingStartedAt = 0;
		}

		const entry = this.entries.at(-1);
		if (this.activeSegment && !this.markdownNode && !this.thinkHeaderNode) {
			// Empty segment — prune from chat (ALE-BUG-7).
			if (entry) {
				this.chat.removeChild(entry.spacer);
				this.chat.removeChild(entry.header);
				this.chat.removeChild(entry.box);
				this.entries.pop();
			}
			const idx = this.segments.indexOf(this.activeSegment);
			if (idx >= 0) this.segments.splice(idx, 1);
		} else if (entry) {
			// Add pill footer.
			const { agentFg, agentBg } = this.t;
			const hasBg = agentBg.truecolor !== undefined || agentBg.ansi256 !== undefined || agentBg.ansi16 !== undefined;
			const bgFn = hasBg ? (s: string) => bg(s, agentBg) : null;
			const footer = new DynamicText((w) =>
				bgFn ? bgFn(color(pillFooterStr(w), agentFg)) : color(pillFooterStr(w), agentFg),
			);
			this.chat.addChild(footer);
			entry.footer = footer;
		}

		this.activeSegment = null;
		this.markdownNode = null;
		this.thinkNode = null;
		this.thinkHeaderNode = null;
	}

	/** Remove all segments — abort/error path only. */
	clear(): void {
		this.replyTypewriter.reset();
		this.thinkTypewriter.reset();
		for (const entry of this.entries) {
			this.chat.removeChild(entry.spacer);
			this.chat.removeChild(entry.header);
			this.chat.removeChild(entry.box);
			if (entry.footer) this.chat.removeChild(entry.footer);
		}
		this.entries.length = 0;
		this.segments.length = 0;
		this.activeSegment = null;
		this.markdownNode = null;
		this.thinkNode = null;
		this.thinkHeaderNode = null;
		this.thinkingStartedAt = 0;
	}

	// ---------------------------------------------------------------------------
	// Content ingestion
	// ---------------------------------------------------------------------------

	receiveText(chunk: string): void {
		const seg = this.openSegment();
		if (!this.markdownNode) {
			this.markdownNode = new Markdown("", 2, 0, makeMarkdownTheme(this.t));
			seg.addChild(this.markdownNode);
			this.trace("receiveTextChunk:first", { markdownNode: true });
		}
		this._chunksReceived++;
		this.replyTypewriter.receive(chunk);
	}

	receiveThinking(chunk: string): void {
		const seg = this.openSegment();
		if (!this.thinkNode) {
			this.thinkingStartedAt = Date.now();
			this.thinkHeaderNode = new Text(color(dim("┊ thinking"), this.t.dimFg), 2, 0);
			seg.addChild(this.thinkHeaderNode);
			this.thinkNode = new Markdown("", 2, 0, makeThinkingMarkdownTheme(this.t));
			if (!this._hideThinking) seg.addChild(this.thinkNode);
		}
		this.thinkTypewriter.receive(chunk);
	}

	/** Add a component directly to the currently-open segment box (or chat if none open). */
	addToCurrentSegment(component: Component): void {
		if (this.activeSegment) {
			this.activeSegment.addChild(component);
		} else {
			this.chat.addChild(component);
		}
	}
}
