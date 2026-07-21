/**
 * Session replay tests.
 *
 * Replay synthetic AgentEvent sequences through the full TUI dispatch
 * pipeline at real timing. RenderRecorder captures every frame; assertions
 * verify no rendering corruption across the full history.
 */

import { Text, TUI } from "@dpopsuev/alef-tui";
import { OutputPanel } from "@dpopsuev/alef-tui/views";
import { describe, expect, it } from "vitest";
import { RenderRecorder } from "../../ui/tui/test/render-recorder.js";
import { VirtualTerminal } from "../../ui/tui/test/virtual-terminal.js";
import { PromptConsole } from "../src/client/console.js";
import { dispatchTuiEvent } from "../src/client/events.js";
import { initialTuiState, type TuiState, type TuiUi } from "../src/client/state.js";
import { getTheme } from "../src/client/theme.js";
import {
	buildCardCycleRecording,
	buildConcurrentToolsRecording,
	buildShellExecRecording,
	replaySession,
} from "./session-replay.js";

const BRAILLE_RE = /[\u2800-\u28FF]/;
const SEPARATOR_RE = /[─\u2500]{3,}/;

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

async function settle(ms = 30): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
}

function setupTui(width = 80, height = 20) {
	const terminal = new VirtualTerminal(width, height);
	const tui = new TUI(terminal);
	terminal.start(
		() => {},
		() => {},
	);
	tui.start();

	const t = getTheme();
	const output = new OutputPanel({ tui, t, labels: { humanLabel: "you", agentLabel: "alef" } });
	const pc = new PromptConsole(tui, t, "test-model");
	pc.mount();
	pc.setStatus("INSERT");

	const footer = new Text("~/test (main)  ctx 100k", 0, 0);
	tui.addChild(footer);

	const recorder = new RenderRecorder(tui);

	let tuiState: TuiState = initialTuiState();

	const ui: TuiUi = {
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

	const dispatch = (event: any) => {
		tuiState = dispatchTuiEvent(tuiState, event, ui);
	};

	tui.requestRender(true);

	return {
		terminal,
		tui,
		pc,
		recorder,
		dispatch,
		cleanup: () => {
			if (pc.isThinking) pc.stopThinking();
			recorder.dispose();
			tui.stop();
		},
	};
}

describe("session replay", { tags: ["unit"] }, () => {
	it("shell.exec replay: no separator contamination across all frames", async () => {
		const { terminal, recorder, dispatch, cleanup } = setupTui();
		await settle(50);

		const recording = buildShellExecRecording({ chunkCount: 30, chunkIntervalMs: 50 });
		await replaySession(recording, dispatch, { timeScale: 0.3, maxDelayMs: 100 });
		await settle(300);
		await terminal.flush();

		const hits = recorder.framesWithContentOnSeparator(/PASS test\//);
		expect(
			hits.length,
			`tool output on separator in ${hits.length} frames:\n${hits.map((h) => `  frame ${h.frame.seq} line ${h.line}: "${h.text}"`).join("\n")}`,
		).toBe(0);

		expect(recorder.count, "should have captured frames").toBeGreaterThan(3);
		cleanup();
	});

	it("shell.exec replay: no duplicate braille spinners", async () => {
		const { terminal, recorder, dispatch, cleanup } = setupTui();
		await settle(50);

		const recording = buildShellExecRecording({ chunkCount: 20 });
		await replaySession(recording, dispatch, { timeScale: 0.3 });
		await settle(300);
		await terminal.flush();

		const dupes = recorder.duplicateLines(BRAILLE_RE);
		expect(
			dupes.length,
			`duplicate spinners in ${dupes.length} frames:\n${dupes.map((d) => `  frame ${d.frame.seq}: lines ${d.lines.join(",")}`).join("\n")}`,
		).toBe(0);
		cleanup();
	});

	it("shell.exec replay: card text gone after tool-end", async () => {
		const { terminal, recorder, dispatch, cleanup } = setupTui();
		await settle(50);

		const recording = buildShellExecRecording({ chunkCount: 5 });
		await replaySession(recording, dispatch, { timeScale: 0.5 });
		await settle(300);
		await terminal.flush();

		const endFrame = recorder.frames.find((f) => f.stripped.some((l) => l.includes("exit 0")));
		if (endFrame) {
			const ghosts = recorder.ghostLines("shell.exec", endFrame.seq).filter((g) => BRAILLE_RE.test(g.content));
			expect(ghosts.length, "ghost card after tool-end").toBe(0);
		}
		cleanup();
	});

	it("concurrent tools replay: no dock drift", async () => {
		const { terminal, recorder, dispatch, cleanup } = setupTui();
		await settle(50);

		const recording = buildConcurrentToolsRecording({ toolCount: 3, chunksPerTool: 10 });
		await replaySession(recording, dispatch, { timeScale: 0.3 });
		await settle(300);
		await terminal.flush();

		const drift = recorder.dockDrift({ footerPattern: /~\/test/, modePattern: /INSERT/ });
		expect(
			drift.length,
			`dock drift:\n${drift.map((d) => `  frame ${d.frame.seq}: ${d.element} ${d.fromRow}->${d.toRow}`).join("\n")}`,
		).toBe(0);
		cleanup();
	});

	it("card cycle replay: no ghost lines from previous cycles", async () => {
		const { terminal, recorder, dispatch, cleanup } = setupTui();
		await settle(50);

		const recording = buildCardCycleRecording({ cycles: 5 });
		await replaySession(recording, dispatch, { timeScale: 0.3 });
		await settle(300);
		await terminal.flush();

		for (let i = 0; i < 4; i++) {
			const name = `cmd-${i}`;
			const endFrame = [...recorder.frames].reverse().find((f) => f.stripped.some((l) => l.includes(name)));
			if (endFrame) {
				const ghosts = recorder.ghostLines(name, endFrame.seq).filter((g) => BRAILLE_RE.test(g.content));
				expect(ghosts.length, `ghost "${name}" card`).toBe(0);
			}
		}
		cleanup();
	});

	it("shell.exec replay: final viewport has correct dock structure", async () => {
		const { terminal, dispatch, cleanup } = setupTui();
		await settle(50);

		const recording = buildShellExecRecording({ chunkCount: 10 });
		await replaySession(recording, dispatch, { timeScale: 0.3 });
		await settle(300);

		const viewport = (await terminal.flushAndGetViewport()).map(stripAnsi);

		expect(viewport[viewport.length - 1], "footer").toContain("~/test");
		expect(
			viewport.some((l) => l.includes("INSERT") && SEPARATOR_RE.test(l)),
			"INSERT separator",
		).toBe(true);
		expect(
			viewport.some((l) => SEPARATOR_RE.test(l)),
			"separator exists",
		).toBe(true);

		for (const line of viewport) {
			if (SEPARATOR_RE.test(line)) {
				expect(line, "separator has test output").not.toMatch(/PASS test\//);
			}
		}
		cleanup();
	});
});
