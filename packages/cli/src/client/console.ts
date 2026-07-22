import type { Component, RenderHandle } from "@dpopsuev/alef-tui";
import {
	AgentCard,
	type AgentCardTheme,
	Container,
	Editor,
	type EditorTheme,
	numericInterpolator,
	PendingQueuePanel,
	SeparatorLine,
	SlotMachine,
	Text,
	Toast,
} from "@dpopsuev/alef-tui";
import { INDENT } from "@dpopsuev/alef-tui/views";
export type { Component };

/** Wraps the Editor component with top and bottom separator borders. */
class EditorChrome implements Component {
	private readonly topBorder = new SeparatorLine({ labelAlign: "right" });
	private readonly bottomBorder = new SeparatorLine();

	constructor(private readonly inner: Editor) {}

	/** Lower delimiter left -- INSERT / NORMAL. */
	setModeLabel(label: string): void {
		this.bottomBorder.setLeftLabel(label);
	}

	/** Lower delimiter right -- compacting / compacted notices. */
	setNoticeLabel(label: string): void {
		this.bottomBorder.setRightLabel(label);
	}

	setTopicLabel(label: string): void {
		this.topBorder.setRightLabel(label);
	}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		if (lines.length < 2) return lines;
		lines[0] = this.topBorder.render(width)[0]!;
		const bottomIndex = lines.length - 1 - this.inner.autocompleteLineCount();
		if (bottomIndex >= 1) {
			lines[bottomIndex] = this.bottomBorder.render(width)[0]!;
		}
		return lines;
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

import { accentColorize, DynamicText, fmtMs, spinnerFrame } from "@dpopsuev/alef-tui/views";

/** Braille frames for the thinking line -- never greeter script-letter pools. */
const THINKING_FRAMES = [
	"\u280B",
	"\u2819",
	"\u2839",
	"\u2838",
	"\u283C",
	"\u2834",
	"\u2826",
	"\u2827",
	"\u2807",
	"\u280F",
] as const;
const THINKING_FRAME_MS = 80;
const THINKING_ELAPSED_STEP_MS = 1000;
const CHUNK_ACCUMULATOR_MAX_CHARS = 500;
const CHUNK_TAIL_MAX_CHARS = 120;
const TOAST_DURATION_MS = 3000;

import { EventPressure, pressureToInterval } from "@dpopsuev/alef-agent/event-pressure";
import { lookupColor } from "@dpopsuev/alef-agent/identity/palette";
import { type ColorToken, color, glyph, selectListThemeFromTokens, statusGlyph, type ThemeTokens } from "./theme.js";

/** Prefer header + active plan block + following rows when the dock widget is height-capped. */
export function prioritizeWidgetLines(lines: readonly string[], maxLines: number): string[] {
	if (lines.length <= maxLines) return [...lines];
	const header = lines[0] ?? "";
	const body = lines.slice(1);
	const activeIdx = body.findIndex((line) => line.includes("\u25C4") || /^\s*\u25CF/.test(line));

	let block: string[] = [];
	let rest: string[] = body;
	if (activeIdx >= 0) {
		let end = activeIdx + 1;
		while (
			end < body.length &&
			(/^\s{4,}/.test(body[end]!) || body[end]!.includes("gate \u00B7") || body[end]!.includes("inspect \u00B7"))
		) {
			end++;
		}
		block = body.slice(activeIdx, end);
		rest = [...body.slice(0, activeIdx), ...body.slice(end)];
	}

	const selected: string[] = [...block];
	for (const line of rest) {
		if (selected.length >= maxLines - 2) break;
		selected.push(line);
	}
	const omitted = body.length - selected.length;
	const result = [header, ...selected];
	if (omitted > 0) {
		while (result.length >= maxLines) result.pop();
		result.push(`  \u2026 ${omitted} more`);
	}
	return result.slice(0, maxLines);
}

/**
 * Manages the input-zone UI: editor, spinner, in-flight tool cards, and status widgets.
 *
 * All public methods are pure data mutations -- they update component state
 * but never call requestRender(). The caller (applyIntents or the thinking
 * timer) is responsible for requesting a render after mutations complete.
 */
export class DockConsole {
	readonly editor: Editor;

	/** Callback invoked by timers to dispatch events through the intent system.
	 *  Set by the wiring layer. Receives the event type to dispatch. */
	onDispatch?: (type: "thinking.tick" | "toast.expired") => void;

	private readonly statusText: Text;
	private editorWrapper!: EditorChrome;
	private thinkingStart = 0;
	private lastThinkingText = "";
	private thinkingTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly pressure = new EventPressure();
	private readonly tui: RenderHandle;
	private readonly t: ThemeTokens;

	/** Called by the timer instead of doing work directly. Set by wiring code to dispatch through the intent system. */
	onTick?: () => void;
	/** Called by toast expiry instead of calling requestRender directly. */
	onToastExpired?: () => void;

	private readonly pendingFooter: DynamicText;

	private noticeClearAfterTurns: number | null = null;

	private readonly inFlightQueue = new Container();
	private readonly inFlightCalls = new Map<
		string,
		{
			card: AgentCard;
			startedAt: number;
			lastChunk: string;
			identity: { color: string; address: string; token: ColorToken; modelId?: string } | null;
			inputSlot: SlotMachine<number>;
			outputSlot: SlotMachine<number>;
			children: Map<
				string,
				{ name: string; keyArg: string; args: Record<string, unknown>; startedAt: number; depth: number }
			>;
		}
	>();
	private cardTheme: AgentCardTheme | undefined;
	private readonly chunkDetail: Text;
	private readonly inspectorHint: Text;
	private focusedId: string | null = null;
	private hintBar!: Text;
	private intentText = "";
	private pendingToastExpiry: Toast | null = null;
	private readonly backgroundTaskPanel = new Text("", 0, 0);
	private readonly backgroundTasks = new Map<
		string,
		{ taskId: string; profile: string; status: string; startedAt: number; updatedAt: number; detail?: string }
	>();
	private readonly pendingQueue: PendingQueuePanel;
	readonly widgetSlotAbove = new Container();
	readonly widgetSlotBelow = new Container();
	private widgetAboveText: Text | null = null;

	constructor(tui: RenderHandle, t: ThemeTokens, _modelId: string) {
		this.tui = tui;
		this.t = t;

		this.statusText = new Text("", 0, 0);
		this.pendingQueue = new PendingQueuePanel({
			theme: {
				item: (s) => color(s, t.mutedFg),
				hint: (s) => color(s, t.mutedFg),
			},
			maxVisible: 5,
		});

		const editorTheme: EditorTheme = {
			borderColor: (s) => color(s, t.mutedFg),
			selectList: selectListThemeFromTokens(t, "accent"),
			ghostHint: (s) => color(s, t.mutedFg),
		};
		this.editor = new Editor(tui, editorTheme);

		this.chunkDetail = new Text("", 2, 0);
		this.inspectorHint = new Text("", 0, 0);

		this.pendingFooter = new DynamicText(() => "");
	}

	mount(): void {
		this.tui.addChild(this.pendingFooter);
		this.tui.setDock(this.pendingFooter);
		this.tui.addChild(this.inFlightQueue);
		this.tui.addChild(this.chunkDetail);
		this.tui.addChild(this.inspectorHint);
		this.tui.addChild(this.backgroundTaskPanel);
		this.tui.addChild(this.statusText);
		this.tui.addChild(this.widgetSlotAbove);
		this.tui.addChild(this.pendingQueue);
		this.editorWrapper = new EditorChrome(this.editor);
		this.tui.addChild(this.editorWrapper);
		this.tui.addChild(this.widgetSlotBelow);

		this.hintBar = new Text("", 0, 0);
		this.tui.addChild(this.hintBar);
		this.editor.armIdleHints();
	}

	pulse(): void {
		this.pressure.pulse();
	}

	startThinking(): void {
		this.editor.suppressCursor = true;
		if (this.thinkingTimer) {
			clearTimeout(this.thinkingTimer);
			this.thinkingTimer = undefined;
		}
		this.thinkingStart = Date.now();
		this.lastThinkingText = "";
		const tick = (): void => {
			if (this.onDispatch) {
				this.onDispatch("thinking.tick");
			} else {
				this.tickThinking();
				this.tui.requestRender();
			}
			const level = this.pressure.level();
			this.thinkingTimer = setTimeout(tick, pressureToInterval(level));
		};
		this.thinkingTimer = setTimeout(tick, pressureToInterval(0));
		if (this.inFlightCalls.size > 0) this.editor.showGhostHint("Tab to inspect subagents");
		else this.editor.clearGhostHint();
	}

	stopThinking(): void {
		this.editor.suppressCursor = false;
		clearTimeout(this.thinkingTimer);
		this.thinkingTimer = undefined;
		this.statusText.setText("");
		this.hintBar.setText("");
		this.editor.clearGhostHint();
		this.intentText = "";
	}

	setStatus(text: string, _clearAfterTurns?: number): void {
		this.editorWrapper.setModeLabel(text);
	}

	setNotice(text: string, clearAfterTurns?: number): void {
		this.editorWrapper.setNoticeLabel(text);
		if (clearAfterTurns !== undefined && clearAfterTurns > 0) {
			this.noticeClearAfterTurns = clearAfterTurns;
		} else {
			this.noticeClearAfterTurns = null;
		}
	}

	onTurnComplete(): void {
		if (this.noticeClearAfterTurns !== null) {
			this.noticeClearAfterTurns -= 1;
			if (this.noticeClearAfterTurns <= 0) {
				this.editorWrapper.setNoticeLabel("");
				this.noticeClearAfterTurns = null;
			}
		}
	}

	setHint(text: string): void {
		const plain = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
		this.hintBar.setText("");
		if (plain) this.editor.showGhostHint(plain);
		else this.editor.clearGhostHint();
	}

	setIntent(text: string): void {
		this.intentText = text;
	}

	setTopicLabel(text: string): void {
		const title = text.trim();
		this.editorWrapper.setTopicLabel(title ? color(title, this.t.accentFg) : "");
	}

	setWidgetAbove(text: string): void {
		if (!this.widgetAboveText) {
			if (!text) return;
			this.widgetAboveText = new Text("", 0, 0);
			this.widgetSlotAbove.addChild(this.widgetAboveText);
		}
		if (!text) {
			this.widgetSlotAbove.removeChild(this.widgetAboveText);
			this.widgetAboveText = null;
			return;
		}
		const firstLine = text.split("\n").find((line) => line.trim()) ?? text;
		const display = firstLine.startsWith("Plan \u00B7")
			? color(firstLine, this.t.mutedFg)
			: color(firstLine, this.t.secondaryFg);
		this.widgetAboveText.setText(display);
	}

	get isThinking(): boolean {
		return this.thinkingTimer !== undefined;
	}

	private getCardTheme(): AgentCardTheme {
		if (!this.cardTheme) {
			const t = this.t;
			this.cardTheme = {
				primary: (s) => color(s, t.primaryFg),
				secondary: (s) => color(s, t.secondaryFg),
				muted: (s) => color(s, t.mutedFg),
				accent: (s) => color(s, t.accentFg),
				identity: (s) => color(s, t.accentFg),
			};
		}
		return this.cardTheme;
	}

	showInFlightCall(callId: string, name: string, keyArg: string, args: Record<string, unknown>): void {
		const startedAt = Date.now();
		const card = new AgentCard(this.getCardTheme(), {
			name,
			keyArg,
			args,
			elapsedMs: 0,
			inputTokens: 0,
			outputTokens: 0,
			lastChunk: "",
			spinner: spinnerFrame(callId, 0),
			children: [],
		});
		const fmtCompact = (n: number) => {
			if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
			if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
			return String(n);
		};
		const slotOpts = {
			format: fmtCompact,
			interpolate: numericInterpolator,
			style: (s: string) => color(s, this.t.secondaryFg),
			dimStyle: (s: string) => color(s, this.t.mutedFg),
		};
		const entry = {
			card,
			startedAt,
			lastChunk: "",
			identity: null as { color: string; address: string; token: ColorToken; modelId?: string } | null,
			inputSlot: new SlotMachine(this.tui, 0, { ...slotOpts, prefix: "\u2191" }),
			outputSlot: new SlotMachine(this.tui, 0, { ...slotOpts, prefix: "\u2193" }),
			children: new Map<
				string,
				{ name: string; keyArg: string; args: Record<string, unknown>; startedAt: number; depth: number }
			>(),
		};
		this.inFlightCalls.set(callId, entry);
		this.inFlightQueue.addChild(card);
		if (this.inFlightCalls.size === 1 && this.isThinking) {
			this.statusText.setText("");
			this.lastThinkingText = "";
			this.editor.showGhostHint("Tab to inspect subagents");
		}
	}

	private readonly chunkAccumulators = new Map<string, string>();

	updateInFlightCallChunk(callId: string, text: string): void {
		const entry = this.inFlightCalls.get(callId);
		if (entry) {
			const accumulated = (this.chunkAccumulators.get(callId) ?? "") + text;
			this.chunkAccumulators.set(callId, accumulated.slice(-CHUNK_ACCUMULATOR_MAX_CHARS));
			const lines = accumulated.split("\n").filter((l) => l.trim());
			entry.lastChunk = (lines.at(-1) ?? "").slice(-CHUNK_TAIL_MAX_CHARS);
		}
	}

	removeInFlightCall(callId: string): void {
		const entry = this.inFlightCalls.get(callId);
		if (entry) {
			entry.inputSlot.dispose();
			entry.outputSlot.dispose();
			this.inFlightQueue.removeChild(entry.card);
			this.inFlightCalls.delete(callId);
			this.chunkAccumulators.delete(callId);
			if (this.inFlightCalls.size === 0 && this.isThinking) {
				this.editor.clearGhostHint();
				this.renderThinkingSpinner();
			}
			this.refreshCards();
		}
	}

	showPendingFooter(_fg: ColorToken): void {}

	hidePendingFooter(): void {}

	setFocusedCall(callId: string | null): void {
		this.focusedId = callId;
		if (callId) {
			this.inspectorHint.setText(color("  j/k scroll  Esc close  Ctrl+X cancel", this.t.mutedFg));
		} else {
			this.chunkDetail.setText("");
			this.inspectorHint.setText("");
		}
		this.refreshCards();
	}

	setChunkText(text: string): void {
		this.chunkDetail.setText(text);
	}

	setCallIdentity(callId: string, colorName: string, address: string, modelId?: string): void {
		const entry = this.inFlightCalls.get(callId);
		if (!entry) return;
		const paletteColor = lookupColor(colorName);
		const token = paletteColor ? { truecolor: paletteColor.hex } : this.t.accentFg;
		entry.identity = { color: colorName, address, token, modelId };
		entry.card.update({ address, modelId });
	}

	updateCallTokens(callId: string, input: number, output: number): void {
		const entry = this.inFlightCalls.get(callId);
		if (!entry) return;
		entry.inputSlot.set(input);
		entry.outputSlot.set(output);
	}

	addChildCall(
		parentCallId: string,
		callId: string,
		name: string,
		keyArg: string,
		args: Record<string, unknown>,
		depth: number,
	): void {
		const entry = this.inFlightCalls.get(parentCallId);
		if (!entry) return;
		entry.children.set(callId, { name, keyArg, args, startedAt: Date.now(), depth });
	}

	removeChildCall(parentCallId: string, callId: string): void {
		const entry = this.inFlightCalls.get(parentCallId);
		if (!entry) return;
		entry.children.delete(callId);
	}

	showToast(message: string, durationMs = TOAST_DURATION_MS): void {
		const toast = new Toast({
			message,
			durationMs,
			theme: {
				text: (s) => color(s, this.t.secondaryFg),
				dim: (s) => color(s, this.t.mutedFg),
			},
			onExpire: () => {
				this.pendingToastExpiry = toast;
				if (this.onDispatch) {
					this.onDispatch("toast.expired");
				} else {
					this.expireToast();
					this.tui.requestRender();
				}
			},
		});
		this.widgetSlotBelow.addChild(toast);
	}

	expireToast(): void {
		if (this.pendingToastExpiry) {
			this.widgetSlotBelow.removeChild(this.pendingToastExpiry);
			this.pendingToastExpiry = null;
		}
	}

	showBackgroundTask(taskId: string, profile: string): void {
		this.backgroundTasks.set(taskId, {
			taskId,
			profile,
			status: "running",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});
		this.refreshBackgroundTaskPanel();
	}

	syncPendingQueue(opts: { queueLength: number; text?: string; mode?: "steer" | "followUp" | "nextTurn" }): string[] {
		const promoted: string[] = [];
		if (opts.text) {
			const prefix =
				opts.mode === "followUp"
					? "Follow-up"
					: opts.mode === "nextTurn"
						? "Next turn"
						: opts.mode === "steer"
							? "Steering"
							: "Queued";
			this.pendingQueue.push({ text: opts.text, prefix });
			this.pendingQueue.setLength(opts.queueLength);
		} else {
			const before = this.pendingQueue.getItems();
			const keep = Math.max(0, opts.queueLength);
			const removeCount = Math.max(0, before.length - keep);
			for (let i = 0; i < removeCount; i++) {
				promoted.push(before[i]!.text);
			}
			this.pendingQueue.setLength(keep);
		}
		return promoted;
	}

	updateBackgroundTask(taskId: string, status: "completed" | "failed", _detail?: string): void {
		const task = this.backgroundTasks.get(taskId);
		if (task) {
			task.status = status;
			task.updatedAt = Date.now();
			task.detail = _detail;
		}
		this.refreshBackgroundTaskPanel();
	}

	private refreshBackgroundTaskPanel(): void {
		if (this.backgroundTasks.size === 0) {
			this.backgroundTaskPanel.setText("");
			return;
		}
		const tasks = [...this.backgroundTasks.values()];
		const running = tasks.filter((task) => task.status === "running").length;
		const failed = tasks.filter((task) => task.status === "failed").length;
		const completed = tasks.filter((task) => task.status === "completed").length;
		const latest = tasks.toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
		const summaryParts = [
			`${statusGlyph("active")} ${running} running`,
			completed > 0 ? `${statusGlyph("done")} ${completed} done` : null,
			failed > 0 ? `${statusGlyph("error")} ${failed} failed` : null,
		].filter(Boolean);
		const latestText = latest ? `  ${latest.taskId} ${latest.profile} ${fmtMs(Date.now() - latest.startedAt)}` : "";
		this.backgroundTaskPanel.setText(
			color(
				`  Tasks \u00B7 ${summaryParts.join("  ")}${latestText}`,
				running > 0 ? this.t.accentFg : this.t.mutedFg,
			),
		);
	}

	tickThinking(): void {
		if (!this.isThinking) return;
		const hasCards = this.inFlightCalls.size > 0;
		if (hasCards) {
			if (this.lastThinkingText !== "") {
				this.lastThinkingText = "";
				this.statusText.setText("");
			}
			this.refreshCards();
		} else {
			this.renderThinkingSpinner();
		}
	}

	private renderThinkingSpinner(): void {
		const elapsedMs = Date.now() - this.thinkingStart;
		const elapsedS = fmtMs(Math.floor(elapsedMs / THINKING_ELAPSED_STEP_MS) * THINKING_ELAPSED_STEP_MS);
		const frameIdx = Math.floor(elapsedMs / THINKING_FRAME_MS) % THINKING_FRAMES.length;
		const frame = THINKING_FRAMES[frameIdx] ?? glyph("state:active");
		const colorize = accentColorize(this.t.accentFg, elapsedMs);
		const intent = this.intentText ? `  ${color(this.intentText, this.t.mutedFg)}` : "";
		const pad = " ".repeat(INDENT.BLOCK);
		const text = `${pad}${colorize(frame)} ${colorize(elapsedS)}${intent}`;
		this.lastThinkingText = text;
		this.statusText.setText(text);
	}

	private refreshCards(): void {
		const hasFocus = this.focusedId !== null;
		for (const [callId, entry] of this.inFlightCalls) {
			const focused = callId === this.focusedId;
			const elapsed = Date.now() - entry.startedAt;
			entry.card.focused = focused;
			entry.card.dimmed = hasFocus && !focused;
			entry.card.update({
				elapsedMs: elapsed,
				spinner: spinnerFrame(callId, elapsed),
				lastChunk: entry.lastChunk,
				inputTokens: entry.inputSlot.get(),
				outputTokens: entry.outputSlot.get(),
				tokenDisplay:
					entry.inputSlot.get() > 0
						? `${entry.inputSlot.currentStyled()} ${entry.outputSlot.currentStyled()}`
						: undefined,
				children: [...entry.children.entries()].map(([id, c]) => ({
					id,
					name: c.name,
					keyArg: c.keyArg,
					args: c.args,
					elapsedMs: Date.now() - c.startedAt,
					depth: c.depth,
					spinner: spinnerFrame(id, Date.now() - c.startedAt),
				})),
			});
		}
	}
}
