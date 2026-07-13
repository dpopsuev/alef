import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { ThemeTokens } from "../theme-types.js";
import { Container, type TUI } from "../tui.js";
import { AgentForum } from "./agent-forum.js";
import { ChatLog, type ChatLogLabels } from "./chat-log.js";
import { ReplyBlock } from "./reply-block.js";
import { prependSessionHistory } from "./session-history.js";
import { Typewriter } from "./typewriter.js";

/**
 *
 */
export interface OutputPanelOptions {
	tui: TUI;
	t: ThemeTokens;
	labels: ChatLogLabels;
}

/**
 *
 */
export class OutputPanel {
	readonly writer: ChatLog;
	readonly replyBlock: ReplyBlock;
	readonly replyTW: Typewriter;
	readonly thinkingTW: Typewriter;
	readonly forums: AgentForum;

	private readonly chatParent: Container;

	constructor(opts: OutputPanelOptions) {
		const { tui, t, labels } = opts;

		this.chatParent = new Container();
		tui.addChild(this.chatParent);
		const chat = new Container();
		this.chatParent.addChild(chat);

		this.forums = new AgentForum(this.chatParent, chat);
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

	loadHistory(store: SessionStore, tui: TUI, cwd?: string): void {
		prependSessionHistory(store, this.writer, { maxTurns: 5, cwd })
			.then(() => tui.requestRender())
			.catch(() => {});
	}
}
