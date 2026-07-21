/**
 * TUI Ticker -- mechanical clock for deterministic TUI render testing.
 *
 * Instead of real timers and settle() delays, the ticker drives the TUI
 * like a game loop: inject event, advance clock, snapshot viewport, assert.
 * Every render is captured by RenderRecorder. No flaky timing.
 *
 * Uses vi.useFakeTimers() internally. Caller must NOT set fake timers.
 *
 * Usage:
 *   const ticker = createTicker({ width: 80, height: 20 });
 *   ticker.addChat("msg 0");
 *   ticker.inject({ type: "tool-start", callId: "c1", name: "shell.exec", args: { command: "ls" } });
 *   await ticker.tick(100);  // advance 100ms -- fires thinking timer + render
 *   const snap = ticker.snapshot();
 *   expect(snap.stripped).not.toContain(...);
 *   ticker.dispose();
 */

import type { AgentEvent } from "@dpopsuev/alef-session/contracts";
import { Container, Text, TUI } from "@dpopsuev/alef-tui";
import { OutputPanel } from "@dpopsuev/alef-tui/views";
import { vi } from "vitest";
import { RenderRecorder } from "../../ui/tui/test/render-recorder.js";
import { VirtualTerminal } from "../../ui/tui/test/virtual-terminal.js";
import { DockConsole } from "../src/client/console.js";
import { dispatchEvent } from "../src/client/events.js";
import { type DispatchPorts, type DispatchState, initialDispatchState } from "../src/client/state.js";
import { getTheme } from "../src/client/theme.js";

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** Snapshot of the viewport at a point in time. */
export interface Snapshot {
	/** Raw viewport lines (with ANSI). */
	lines: string[];
	/** ANSI-stripped viewport lines. */
	stripped: string[];
	/** Elapsed fake time in ms. */
	elapsedMs: number;
	/** Number of frames rendered so far. */
	frameCount: number;
	/** Last render path taken. */
	lastPath: string;
}

export interface Ticker {
	/** The TUI instance. */
	tui: TUI;
	/** The DockConsole. */
	pc: DockConsole;
	/** The RenderRecorder capturing every frame. */
	recorder: RenderRecorder;
	/** The VirtualTerminal. */
	terminal: VirtualTerminal;
	/** The chat container (scrollable area). */
	chat: Container;

	/** Inject an AgentEvent through the full dispatch pipeline. */
	inject(event: AgentEvent): void;

	/** Add a text line to the chat area. */
	addChat(text: string): void;

	/** Advance fake time by ms. Flushes nextTick, render timers, thinking timer. */
	tick(ms: number): Promise<void>;

	/** Force a render and advance enough time for it to complete. */
	render(): Promise<void>;

	/** Take a snapshot of the current viewport. */
	snapshot(): Snapshot;

	/** Dispose everything: restore real timers, stop TUI, dispose recorder. */
	dispose(): void;
}

export interface TickerOptions {
	width?: number;
	height?: number;
}

export function createTicker(opts: TickerOptions = {}): Ticker {
	const width = opts.width ?? 80;
	const height = opts.height ?? 20;

	vi.useFakeTimers({ shouldAdvanceTime: false });

	const terminal = new VirtualTerminal(width, height);
	const tui = new TUI(terminal);
	terminal.start(
		() => {},
		() => {},
	);
	tui.start();

	const t = getTheme();
	const chat = new Container();
	tui.addChild(chat);
	const output = new OutputPanel({ tui, t, labels: { humanLabel: "you", agentLabel: "alef" } });

	const pc = new DockConsole(tui, t, "test-model");
	pc.mount();
	pc.setStatus("INSERT");

	const footer = new Text("~/test (main)  ctx 100k", 0, 0);
	tui.addChild(footer);

	const recorder = new RenderRecorder(tui);

	let tuiState: DispatchState = initialDispatchState();

	const ui: DispatchPorts = {
		writer: output.writer,
		replyBlock: output.replyBlock,
		replyTW: output.replyTW,
		thinkingTW: output.thinkingTW,
		promptConsole: pc,
		tui,
		t,
		session: {
			getDiscussion: () => undefined,
			setDiscussion: () => {},
			cancelToolCall: () => {},
		} as any,
	};

	let elapsed = 0;

	const ticker: Ticker = {
		tui,
		pc,
		recorder,
		terminal,
		chat,

		inject(event: AgentEvent): void {
			tuiState = dispatchEvent(tuiState, event, ui);
		},

		addChat(text: string): void {
			chat.addChild(new Text(text, 0, 0));
		},

		async tick(ms: number): Promise<void> {
			await vi.advanceTimersByTimeAsync(ms);
			elapsed += ms;
		},

		async render(): Promise<void> {
			tui.requestRender(true);
			await vi.advanceTimersByTimeAsync(20);
		},

		snapshot(): Snapshot {
			const lines = terminal.getViewport();
			return {
				lines,
				stripped: lines.map(stripAnsi),
				elapsedMs: elapsed,
				frameCount: recorder.count,
				lastPath: recorder.last?.meta.renderPath ?? "none",
			};
		},

		dispose(): void {
			if (pc.isThinking) pc.stopThinking();
			recorder.dispose();
			tui.stop();
			vi.useRealTimers();
		},
	};

	return ticker;
}
