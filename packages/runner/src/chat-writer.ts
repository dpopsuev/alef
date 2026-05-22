/**
 * ChatWriter — single write path for all content in the chat Container.
 *
 * Every visible element in the chat goes through ChatWriter. No code outside
 * this class may call chat.addChild(new Text(...)) or chat.addChild(new Markdown(...)).
 *
 * Two write modes:
 *   Instant  — content appears immediately (user messages, notices, tool status, errors)
 *   Streamed — content drains at pressure-adaptive rate (LLM reply, thinking)
 *
 * Streaming text uses Markdown.setText() updated on each chunk — the Pi pattern
 * (AssistantMessageComponent.updateContent). Thinking uses Typewriter for pacing.
 * Instant content uses Typewriter.receive + markStreamDone (flush = appear now).
 */

import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@dpopsuev/alef-tui";
import chalk from "chalk";
import { DynamicText } from "./dynamic-text.js";
import { bold, boldColor, color, dim, getTheme, glyph, italic } from "./theme.js";
import { pillFooterStr, pillHeaderStr, renderToolLine, truncateToolOutput } from "./tui-mode.js";
import { Typewriter } from "./typewriter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolHandle {
	/** Update the status line when the tool completes. */
	complete(elapsedMs: number, ok: boolean, result?: string): void;
}

// ---------------------------------------------------------------------------
// ChatWriter
// ---------------------------------------------------------------------------

export class ChatWriter {
	private readonly chat: Container;
	private readonly requestRender: (force?: boolean) => void;
	private readonly markdownTheme: MarkdownTheme;

	// Streaming state — one active generation at a time.
	private readonly streamingSegments: Container[] = [];
	private streamingSegment: Container | null = null;
	private streamingMarkdownNode: Markdown | null = null;
	private streamingAccumulated = "";

	// Thinking state — persists across tool-call seals within a turn.
	private streamingThinkNode: Text | null = null;
	private accumulatedThinking = "";
	private readonly thinkTypewriter: Typewriter;

	// Token footer — filled when onTokenUsage fires after the reply.
	private pendingTokenFooter: Text | null = null;

	constructor(chat: Container, requestRender: (force?: boolean) => void) {
		this.chat = chat;
		this.requestRender = requestRender;
		this.markdownTheme = this.buildMarkdownTheme();
		this.thinkTypewriter = new Typewriter({ setText: (t) => this.streamingThinkNode?.setText(italic(dim(t))) }, () =>
			this.requestRender(),
		);
	}

	// ---------------------------------------------------------------------------
	// Instant writes — appear immediately
	// ---------------------------------------------------------------------------

	/** Echo the user's submitted message in the chat. */
	addUserMessage(text: string): void {
		const t = getTheme();
		const you = process.env.ALEF_YOU_LABEL ?? "@you";
		this.addPillBlock(
			you,
			(s) => color(s, t.accentFg),
			() => {
				this.chat.addChild(new Text(text, 2, 0));
			},
		);
	}

	/** System or slash-command notice. */
	addNotice(text: string): void {
		const t = getTheme();
		this.addPillBlock(
			"─",
			(s) => dim(color(s, t.dimFg)),
			() => {
				this.chat.addChild(new Text(dim(text), 2, 0));
			},
		);
	}

	/** Tool call start — returns a handle to finalize when complete. */
	addToolStart(name: string, keyArg: string): ToolHandle {
		const t = getTheme();
		const activeLabel = `${color(glyph("state:active"), t.warnFg)} ${color(name, t.toolNameFg)}`;
		const activeBody = keyArg ? `  ${color(keyArg, t.toolArgFg)}` : "";
		const line = new Text(`  ${activeLabel}${activeBody}`, 1, 0);
		this.chat.addChild(line);
		this.requestRender();

		return {
			complete: (elapsedMs, ok, result) => {
				line.setText(renderToolLine(name, keyArg, elapsedMs, ok));
				if (result?.trim()) {
					const th = getTheme();
					this.chat.addChild(new Text(color(dim(truncateToolOutput(result)), th.dimFg), 3, 0));
				}
				this.requestRender();
			},
		};
	}

	/** Token usage footer — placed after the current reply. */
	setTokenUsage(input: number, output: number): void {
		const compact = (n: number) =>
			n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
		const footer = dim(`${compact(input)} in · ${compact(output)} out`);
		if (this.pendingTokenFooter) {
			this.pendingTokenFooter.setText(footer);
			this.pendingTokenFooter = null;
			this.requestRender();
		}
	}

	/** Clear all chat content. */
	clear(): void {
		while (this.chat.children.length > 0) {
			this.chat.removeChild(this.chat.children[0]);
		}
	}

	// ---------------------------------------------------------------------------
	// Streaming writes — Markdown updated in-place per chunk
	// ---------------------------------------------------------------------------

	/** Called for each LLM text delta. Creates/updates Markdown node in place. */
	receiveTextChunk(chunk: string): void {
		const box = this.openStreamingSegment();
		if (!this.streamingMarkdownNode) {
			this.streamingAccumulated = "";
			this.streamingMarkdownNode = new Markdown("", 2, 0, this.markdownTheme);
			box.addChild(this.streamingMarkdownNode);
		}
		this.streamingAccumulated += chunk;
		this.streamingMarkdownNode.setText(this.streamingAccumulated);
		this.requestRender();
	}

	/** Called for each thinking delta. Paced via Typewriter. */
	receiveThinkingChunk(chunk: string): void {
		this.accumulatedThinking += chunk;
		const box = this.openStreamingSegment();
		if (!this.streamingThinkNode) {
			const t = getTheme();
			box.addChild(new Text(color(dim("┊ thinking"), t.dimFg), 2, 0));
			this.streamingThinkNode = new Text("", 2, 0);
			box.addChild(this.streamingThinkNode);
		}
		this.thinkTypewriter.receive(chunk);
	}

	/**
	 * Freeze the current streaming segment so tool call lines appear below it.
	 * Called when the first tool fires during a generation phase.
	 */
	sealStreamingSegment(): void {
		this.thinkTypewriter.flush();
		this.thinkTypewriter.reset();
		this.streamingSegment = null;
		this.streamingMarkdownNode = null;
		this.streamingAccumulated = "";
		this.streamingThinkNode = null;
	}

	/**
	 * Finalize turn: persist thinking block, add token footer placeholder.
	 * The streaming Markdown node is already in chat with the full reply — no swap.
	 */
	finalizeTurn(): void {
		this.thinkTypewriter.markStreamDone();
		const savedThinking = this.accumulatedThinking.trim();
		this.accumulatedThinking = "";
		this.sealStreamingSegment();

		if (savedThinking) {
			const t = getTheme();
			this.chat.addChild(new Spacer(1));
			this.chat.addChild(new Text(color(dim("┊ thinking"), t.dimFg), 2, 0));
			this.chat.addChild(new Text(italic(dim(truncateToolOutput(savedThinking))), 2, 0));
			this.chat.addChild(new Spacer(1));
		}

		const tokenText = new Text("", 1, 0);
		this.chat.addChild(tokenText);
		this.pendingTokenFooter = tokenText;
		this.requestRender(true);
	}

	/** Discard all streaming state on abort/error. */
	abortStreaming(): void {
		this.thinkTypewriter.reset();
		this.accumulatedThinking = "";
		for (const c of this.streamingSegments) this.chat.removeChild(c);
		this.streamingSegments.length = 0;
		this.streamingSegment = null;
		this.streamingMarkdownNode = null;
		this.streamingAccumulated = "";
		this.streamingThinkNode = null;
		this.pendingTokenFooter = null;
	}

	// ---------------------------------------------------------------------------
	// Header (called once at boot, outside the chat Container)
	// ---------------------------------------------------------------------------

	/** Render the session header pill onto the TUI root (not into chat). */
	static renderHeader(
		tui: { addChild(c: unknown): void },
		sessionId: string,
		accentFg: import("./theme.js").ColorToken,
	): void {
		const sessionShort = sessionId.slice(0, 8);
		const headerLabel = `${glyph("bullet")} ALEF  ${glyph("sep")}  ${sessionShort}`;
		tui.addChild(
			new DynamicText((w) => {
				const inner = `─ ${headerLabel} `;
				return boldColor(`╭${inner}${"─".repeat(Math.max(0, w - inner.length - 3))}╮`, accentFg);
			}),
		);
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private openStreamingSegment(): Container {
		if (!this.streamingSegment) {
			this.streamingSegment = new Container();
			this.streamingSegments.push(this.streamingSegment);
			this.chat.addChild(this.streamingSegment);
		}
		return this.streamingSegment;
	}

	private addPillBlock(label: string, colorFn: (s: string) => string, body: () => void): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new DynamicText((w) => colorFn(pillHeaderStr(label, w))));
		body();
		this.chat.addChild(new DynamicText((w) => colorFn(pillFooterStr(w))));
		this.chat.addChild(new Spacer(1));
	}

	private buildMarkdownTheme(): MarkdownTheme {
		const t = getTheme();
		return {
			heading: (s) => bold(s),
			link: (s) => color(s, t.toolNameFg),
			linkUrl: (s) => dim(s),
			code: (s) => color(s, t.accentFg),
			codeBlock: (s) => s,
			codeBlockBorder: (s) => dim(s),
			quote: (s) => dim(s),
			quoteBorder: (s) => dim(s),
			hr: (s) => dim(s),
			listBullet: (s) => color(s, t.accentFg),
			bold: (s) => bold(s),
			italic: (s) => italic(s),
			strikethrough: (s) => s,
			underline: (s) => chalk.underline(s),
		};
	}
}
