import type { AssistantMessage } from "@dpopsuev/alef-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@dpopsuev/alef-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Tracks a content block's component so we can update in-place
 * instead of tearing down and rebuilding on every token.
 */
interface ContentSlot {
	/** Content block index in the message */
	index: number;
	/** "text" or "thinking" */
	type: "text" | "thinking";
	/** The Markdown or Text component for this slot */
	component: Markdown | Text;
	/** Last text value set on this component */
	lastValue: string;
}

/**
 * Component that renders a complete assistant message.
 *
 * During streaming, updateContent is called on every token. To avoid
 * O(n) Markdown re-parses, we track content block components and
 * call setText() on existing Markdown instances when only the text
 * has changed — the Markdown component's internal cache handles the
 * rest.
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;

	/** Tracked slots for incremental updates */
	private slots: ContentSlot[] = [];

	/** Whether the content structure has changed (new blocks added) */
	private structureDirty = true;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.structureDirty = true;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.structureDirty = true;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		this.structureDirty = true;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	/**
	 * Update with display text that may differ from the full message text.
	 * Used by StreamingTextBuffer to show a smoothed subset of the full text.
	 */
	updateDisplayText(contentIndex: number, displayText: string): void {
		const slot = this.slots.find((s) => s.index === contentIndex && s.type === "text");
		if (slot && slot.component instanceof Markdown && slot.lastValue !== displayText) {
			slot.lastValue = displayText;
			slot.component.setText(displayText);
		}
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Determine if structure changed (different number or types of content blocks)
		const contentBlocks = message.content.filter(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		const structureChanged =
			this.structureDirty ||
			contentBlocks.length !== this.slots.length ||
			contentBlocks.some(
				(c, i) => this.slots[i]?.type !== c.type || this.slots[i]?.index !== message.content.indexOf(c),
			);

		if (structureChanged) {
			this.rebuildFull(message);
			return;
		}

		// Fast path: structure unchanged — update text in-place
		for (const block of contentBlocks) {
			const blockIndex = message.content.indexOf(block);
			const slot = this.slots.find((s) => s.index === blockIndex);
			if (!slot) continue;

			if (block.type === "text") {
				const newText = block.text.trim();
				if (slot.lastValue !== newText && slot.component instanceof Markdown) {
					slot.lastValue = newText;
					slot.component.setText(newText);
				}
			} else if (block.type === "thinking") {
				const newText = block.thinking.trim();
				if (slot.lastValue !== newText && slot.component instanceof Markdown) {
					slot.lastValue = newText;
					slot.component.setText(newText);
				}
			}
		}

		// Update tool call and error state
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
	}

	/**
	 * Full rebuild — used when structure changes (new content blocks, type changes, etc.)
	 */
	private rebuildFull(message: AssistantMessage): void {
		this.structureDirty = false;
		this.slots = [];
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				const md = new Markdown(content.text.trim(), 1, 0, this.markdownTheme);
				this.contentContainer.addChild(md);
				this.slots.push({ index: i, type: "text", component: md, lastValue: content.text.trim() });
			} else if (content.type === "thinking" && content.thinking.trim()) {
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					const txt = new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0);
					this.contentContainer.addChild(txt);
					this.slots.push({ index: i, type: "thinking", component: txt, lastValue: this.hiddenThinkingLabel });
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					const md = new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					});
					this.contentContainer.addChild(md);
					this.slots.push({ index: i, type: "thinking", component: md, lastValue: content.thinking.trim() });
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
	}
}
