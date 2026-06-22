import type { SessionStore } from "@dpopsuev/alef-session";
import { Container, type TUI } from "@dpopsuev/alef-tui";
import type { ThemeTokens } from "../theme-types.js";
import { ChatLog, type ChatLogLabels } from "./chat-log.js";
import { ForumManager } from "./forum-manager.js";
import { ReplyBlock } from "./reply-block.js";
import { prependSessionHistory } from "./session-history.js";
import { Typewriter } from "./typewriter.js";

export interface OutputPanelOptions {
	tui: TUI;
	t: ThemeTokens;
	labels: ChatLogLabels;
}

export class OutputPanel {
	readonly writer: ChatLog;
	readonly replyBlock: ReplyBlock;
	readonly replyTW: Typewriter;
	readonly thinkingTW: Typewriter;
	readonly forums: ForumManager;

	private readonly chatParent: Container;

	constructor(opts: OutputPanelOptions) {
		const { tui, t, labels } = opts;

		this.chatParent = new Container();
		tui.addChild(this.chatParent);
		const chat = new Container();
		this.chatParent.addChild(chat);

		this.forums = new ForumManager(this.chatParent, chat);
		this.writer = new ChatLog(chat, t, labels);

		this.replyBlock = new ReplyBlock(chat, () => tui.requestRender(), t, true, labels.agentLabel);
		this.replyTW = new Typewriter(
			(delta) => this.replyBlock.receiveText(delta),
			() => tui.requestRender(),
		);
		this.thinkingTW = new Typewriter(
			(delta) => this.replyBlock.receiveThinking(delta),
			() => tui.requestRender(),
		);
	}

	loadHistory(store: SessionStore, tui: TUI): void {
		prependSessionHistory(store, this.writer, { maxTurns: 5 })
			.then(() => tui.requestRender())
			.catch(() => {});
	}
}
