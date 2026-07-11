/**
 * ChatLog — single write path for all content appended to the chat Container.
 *
 * Replaces the pattern of passing `chat: Container` around and calling free
 * functions on it. tui-mode.ts holds one ChatLog and never calls addChild()
 * on the chat Container directly.
 */

import type { Component } from "../component.js";
import { Collapsible } from "../components/collapsible.js";
import { Markdown } from "../components/markdown.js";
import { Pad } from "../components/pad.js";
import type { Text as TuiText } from "../components/text.js";
import type { ThemeTokens } from "../theme-types.js";
import type { Container } from "../tui.js";
import {
	AgentBlock,
	appendBatchTiming,
	appendCompletedToolBlock,
	appendNotice,
	appendTokenFooter,
	appendUserMsg,
} from "./chat-view.js";
import { makeMarkdownTheme } from "./markdown-themes.js";
import { color } from "./theme.js";
import { makeToolOutputComponent } from "./tool-view.js";

/**
 *
 */
export interface ChatLogLabels {
	humanLabel?: string;
	agentLabel?: string;
}

/**
 *
 */
export class ChatLog {
	private readonly chat: Container;
	private readonly t: ThemeTokens;
	readonly humanLabel: string;
	readonly agentLabel: string;

	constructor(chat: Container, t: ThemeTokens, labels: ChatLogLabels = {}) {
		this.chat = chat;
		this.t = t;
		this.humanLabel = labels.humanLabel ?? "@you";
		this.agentLabel = labels.agentLabel ?? "@alef";
	}

	addUserMessage(text: string): void {
		appendUserMsg(this.chat, text, this.t, this.humanLabel);
	}

	/** Append a completed agent reply as a closed pill — used for session history display. */
	addAgentReply(text: string): void {
		const block = new AgentBlock(this.chat, this.t);
		block.start();
		block.addContent(new Markdown(text, 0, 0, makeMarkdownTheme(this.t)));
		block.end();
	}

	addNotice(text: string): void {
		appendNotice(this.chat, text, this.t);
	}

	addCompletedToolBlock(
		name: string,
		keyArg: string,
		elapsedMs: number,
		ok: boolean,
		display: string | null,
		displayKind: string | null,
	): void {
		const output: Component | null = display
			? makeToolOutputComponent(display, displayKind ?? undefined, this.t)
			: null;
		appendCompletedToolBlock(this.chat, name, keyArg, elapsedMs, ok, output, this.t);
	}

	addSubagentReply(name: string, reply: string): void {
		const collapsible = new Collapsible({
			header: `${name} reply`,
			collapsed: true,
			headerStyle: (s) => `    ${color(s, this.t.secondaryFg)}`,
		});
		const md = new Markdown(reply, 0, 0, makeMarkdownTheme(this.t));
		const padded = new Pad(6, 0);
		padded.addChild(md);
		collapsible.setContent(padded);
		this.chat.addChild(collapsible);
	}

	addBatchTiming(ms: number): void {
		appendBatchTiming(this.chat, ms, this.t);
	}

	/** Append a mutable token-usage footer. Returns a handle to update the text later. */
	addTokenFooter(): TuiText {
		return appendTokenFooter(this.chat);
	}

	/** Remove all children — used by /new and :clear commands. */
	clearAll(): void {
		while (this.chat.children.length > 0) this.chat.removeChild(this.chat.children[0]!);
	}

	/** Direct access to the underlying Container for test introspection. */
	get container(): Container {
		return this.chat;
	}
}
