/**
 * ChatWriter — single write path for all content appended to the chat Container.
 *
 * Replaces the pattern of passing `chat: Container` around and calling free
 * functions on it. tui-mode.ts holds one ChatWriter and never calls addChild()
 * on the chat Container directly.
 */

import type { Component, Container } from "@dpopsuev/alef-tui";
import { Text as TuiText } from "@dpopsuev/alef-tui";
import type { ThemeTokens } from "../theme-types.js";
import {
	AgentBlock,
	appendBatchTiming,
	appendCompletedToolBlock,
	appendNotice,
	appendTokenFooter,
	appendUserMsg,
} from "./chat-view.js";
import { makeToolOutputComponent } from "./tool-view.js";

export interface ChatWriterLabels {
	humanLabel?: string;
	agentLabel?: string;
}

export class ChatWriter {
	private readonly chat: Container;
	private readonly t: ThemeTokens;
	readonly humanLabel: string;
	readonly agentLabel: string;

	constructor(chat: Container, t: ThemeTokens, labels: ChatWriterLabels = {}) {
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
		block.addContent(new TuiText(text, 0, 0));
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

	addBatchTiming(ms: number): void {
		appendBatchTiming(this.chat, ms, this.t);
	}

	/** Append a mutable token-usage footer. Returns a handle to update the text later. */
	addTokenFooter(): TuiText {
		return appendTokenFooter(this.chat);
	}

	/** Remove all children — used by /new and :clear commands. */
	clearAll(): void {
		while (this.chat.children.length > 0) this.chat.removeChild(this.chat.children[0]);
	}

	/** Direct access to the underlying Container for test introspection. */
	get container(): Container {
		return this.chat;
	}
}
