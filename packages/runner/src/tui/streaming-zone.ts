/**
 * StreamingZone — manages the lifecycle of streaming content segments.
 *
 * Each LLM generation phase gets its own Container (segment). When a tool
 * call starts, the current segment is sealed in place; the next generation
 * creates a fresh segment below the tool lines. This preserves chronological
 * order in the chat without explicit ordering logic.
 *
 * Single responsibility: segment open/seal/clear + typewriter plumbing.
 * No knowledge of pills, tool rendering, or turn orchestration.
 */

import { Container, Markdown, Text } from "@dpopsuev/alef-tui";
import { trace } from "../debug-trace.js";
import { color, dim, getTheme, italic } from "../theme.js";
import type { AgentBlock } from "./chat-view.js";
import { makeMarkdownTheme } from "./markdown-themes.js";
import { Typewriter } from "./typewriter.js";

export class StreamingZone {
	/** Exposed for testing only. */
	readonly segments: Container[] = [];
	activeSegment: Container | null = null;
	markdownNode: Markdown | null = null;
	thinkNode: Text | null = null;

	private thinkingStartedAt = 0;
	private _chunksReceived = 0; // debug counter, reset per seal

	readonly replyTypewriter: Typewriter;
	readonly thinkTypewriter: Typewriter;

	constructor(
		private readonly agentBlock: AgentBlock,
		requestRender: () => void,
	) {
		this.replyTypewriter = new Typewriter({ setText: (t) => this.markdownNode?.setText(t) }, requestRender);
		this.thinkTypewriter = new Typewriter({ setText: (t) => this.thinkNode?.setText(italic(dim(t))) }, requestRender);
	}

	// ---------------------------------------------------------------------------
	// Segment lifecycle
	// ---------------------------------------------------------------------------

	private openSegment(): Container {
		if (!this.activeSegment) {
			this.activeSegment = new Container();
			this.segments.push(this.activeSegment);
			this.agentBlock.addContent(this.activeSegment);
		}
		return this.activeSegment;
	}

	/** Freeze the active segment and reset streaming state. */
	seal(): void {
		trace("sealStreamingSegment", {
			chunks: this._chunksReceived,
			markdownNode: this.markdownNode !== null,
			pending: this.replyTypewriter.pendingText.length,
		});
		this._chunksReceived = 0;

		this.replyTypewriter.flush();
		this.replyTypewriter.reset();

		// Collapse thinking to a compact label so it doesn't push reply off-screen.
		const thinkNode = this.thinkNode;
		const pendingThinking = this.thinkTypewriter.pendingText;
		this.thinkTypewriter.flush();
		this.thinkTypewriter.reset();
		if (thinkNode) {
			const elapsedS = this.thinkingStartedAt > 0 ? Math.round((Date.now() - this.thinkingStartedAt) / 1000) : 0;
			const lineCount = pendingThinking ? pendingThinking.split("\n").length : 0;
			const t = getTheme();
			const label =
				elapsedS > 0
					? `thought for ${elapsedS}s (${lineCount} lines)`
					: lineCount > 0
						? `thought (${lineCount} lines)`
						: "";
			thinkNode.setText(label ? color(dim(label), t.dimFg) : "");
			this.thinkingStartedAt = 0;
		}

		// Remove empty segments — they produce blank lines in the layout (ALE-BUG-7).
		if (this.activeSegment && !this.markdownNode && !this.thinkNode) {
			this.agentBlock.removeContent(this.activeSegment);
			const idx = this.segments.indexOf(this.activeSegment);
			if (idx >= 0) this.segments.splice(idx, 1);
		}

		this.activeSegment = null;
		this.markdownNode = null;
		this.thinkNode = null;
	}

	/** Remove all segments — abort/error path only. */
	clear(): void {
		this.replyTypewriter.reset();
		this.thinkTypewriter.reset();
		for (const seg of this.segments) this.agentBlock.removeContent(seg);
		this.segments.length = 0;
		this.activeSegment = null;
		this.markdownNode = null;
		this.thinkNode = null;
		this.thinkingStartedAt = 0;
	}

	// ---------------------------------------------------------------------------
	// Content ingestion
	// ---------------------------------------------------------------------------

	receiveText(chunk: string): void {
		const seg = this.openSegment();
		if (!this.markdownNode) {
			this.markdownNode = new Markdown("", 2, 0, makeMarkdownTheme());
			seg.addChild(this.markdownNode);
			trace("receiveTextChunk:first", { markdownNode: true });
		}
		this._chunksReceived++;
		this.replyTypewriter.receive(chunk);
	}

	receiveThinking(chunk: string): void {
		const seg = this.openSegment();
		if (!this.thinkNode) {
			this.thinkingStartedAt = Date.now();
			const t = getTheme();
			seg.addChild(new Text(color(dim("┊ thinking"), t.dimFg), 2, 0));
			this.thinkNode = new Text("", 2, 0);
			seg.addChild(this.thinkNode);
		}
		this.thinkTypewriter.receive(chunk);
	}
}
