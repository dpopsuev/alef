/**
 * Dock rendering metrics tests.
 *
 * Uses RenderRecorder to capture every frame and assert invariants across
 * the full render history -- not just the final viewport snapshot.
 * These tests catch transient rendering bugs that single-frame assertions miss.
 */

import { Container, Text, TUI } from "@dpopsuev/alef-tui";
import { describe, expect, it } from "vitest";
import { RenderRecorder } from "../../ui/tui/test/render-recorder.js";
import { VirtualTerminal } from "../../ui/tui/test/virtual-terminal.js";
import { PromptConsole } from "../src/client/console.js";
import { getTheme } from "../src/client/theme.js";

async function settle(ms = 30): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
}

const BRAILLE_RE = /[\u2800-\u28FF]/;

function setup(width = 80, height = 20) {
	const terminal = new VirtualTerminal(width, height);
	const tui = new TUI(terminal);
	terminal.start(
		() => {},
		() => {},
	);
	tui.start();

	const chat = new Container();
	tui.addChild(chat);

	const pc = new PromptConsole(tui, getTheme(), "test-model");
	pc.mount();

	const footer = new Text("~/test (main)", 0, 0);
	tui.addChild(footer);

	const recorder = new RenderRecorder(tui);

	return {
		terminal,
		tui,
		pc,
		chat,
		recorder,
		cleanup: () => {
			recorder.dispose();
			tui.stop();
		},
	};
}

describe("dock rendering metrics", { tags: ["unit"] }, () => {
	it("no separator contamination with tool output across all frames", async () => {
		const { tui, pc, chat, recorder, cleanup } = setup();

		for (let i = 0; i < 5; i++) chat.addChild(new Text(`msg ${i}`, 0, 0));
		pc.setStatus("INSERT");
		pc.startThinking();
		pc.showInFlightCall("e1", "shell.exec", "npm test", { command: "npm test" });

		tui.requestRender(true);
		await settle();

		for (let i = 0; i < 30; i++) {
			pc.updateInFlightCallChunk("e1", `PASS test/unit-${i}.test.ts (${i * 10}ms)\n`);
			tui.requestRender();
			await settle(20);
		}

		pc.removeInFlightCall("e1");
		pc.stopThinking();
		tui.requestRender();
		await settle();

		const hits = recorder.framesWithContentOnSeparator(/PASS test\//);
		expect(hits.length, `tool output on separator in ${hits.length} frames`).toBe(0);
		expect(recorder.count).toBeGreaterThan(5);

		cleanup();
	});

	it("at most 1 braille spinner line across all frames when card is showing", async () => {
		const { tui, pc, chat, recorder, cleanup } = setup();

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`msg ${i}`, 0, 0));
		pc.startThinking();
		pc.showInFlightCall("e1", "shell.exec", "ls", { command: "ls" });

		tui.requestRender(true);
		await settle(500);

		for (let i = 0; i < 10; i++) {
			pc.updateInFlightCallChunk("e1", `file-${i}\n`);
			tui.requestRender();
			await settle(50);
		}

		await settle(200);

		const dupes = recorder.duplicateLines(BRAILLE_RE);
		expect(
			dupes.length,
			`${dupes.length} frames with duplicate braille lines:\n${dupes.map((d) => `  frame ${d.frame.seq} lines ${d.lines.join(",")}`).join("\n")}`,
		).toBe(0);

		cleanup();
	});

	it("shell.exec card text gone from all frames after removal", async () => {
		const { tui, pc, chat, recorder, cleanup } = setup();

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`msg ${i}`, 0, 0));
		pc.startThinking();
		pc.showInFlightCall("e1", "shell.exec", "npm test", { command: "npm test" });

		tui.requestRender(true);
		await settle(200);

		const addSeq = recorder.last!.seq;
		expect(recorder.last!.stripped.some((l) => l.includes("shell.exec"))).toBe(true);

		pc.removeInFlightCall("e1");
		tui.requestRender();
		await settle(200);

		const ghosts = recorder.ghostLines("shell.exec", addSeq);
		expect(
			ghosts.length,
			`ghost "shell.exec" in ${ghosts.length} frames after removal:\n${ghosts.map((g) => `  frame ${g.frame.seq} line ${g.line}: "${g.content}"`).join("\n")}`,
		).toBe(0);

		pc.stopThinking();
		cleanup();
	});

	it("dock elements do not drift during streaming", async () => {
		const { tui, pc, chat, recorder, cleanup } = setup();

		for (let i = 0; i < 5; i++) chat.addChild(new Text(`msg ${i}`, 0, 0));
		pc.setStatus("INSERT");
		pc.editor.setText("prompt");

		tui.requestRender(true);
		await settle();

		for (let i = 0; i < 15; i++) {
			chat.addChild(new Text(`stream-${i}`, 0, 0));
			tui.requestRender();
			await settle(20);
		}

		const drift = recorder.dockDrift({ footerPattern: /~\/test/, modePattern: /INSERT/ });
		expect(
			drift.length,
			`dock drift in ${drift.length} frames:\n${drift.map((d) => `  frame ${d.frame.seq}: ${d.element} ${d.fromRow}->${d.toRow}`).join("\n")}`,
		).toBe(0);

		cleanup();
	});

	it("render path distribution during shell.exec lifecycle", async () => {
		const { tui, pc, chat, recorder, cleanup } = setup();

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`msg ${i}`, 0, 0));
		pc.setStatus("INSERT");

		tui.requestRender(true);
		await settle();
		recorder.clear();

		pc.startThinking();
		tui.requestRender();
		await settle(100);

		pc.showInFlightCall("e1", "shell.exec", "ls", { command: "ls" });
		tui.requestRender();
		await settle(100);

		for (let i = 0; i < 10; i++) {
			pc.updateInFlightCallChunk("e1", `output-${i}\n`);
			tui.requestRender();
			await settle(30);
		}

		pc.removeInFlightCall("e1");
		tui.requestRender();
		await settle(100);

		pc.stopThinking();
		tui.requestRender();
		await settle(100);

		const counts = recorder.pathCounts();
		expect(counts.diff ?? 0, `no diff renders: ${JSON.stringify(counts)}`).toBeGreaterThan(0);
		expect(counts["dock-reflow"] ?? 0, `no dock-reflow: ${JSON.stringify(counts)}`).toBeGreaterThan(0);
		expect(counts["width-change"] ?? 0, "unexpected width-change").toBe(0);
		expect(counts["height-change"] ?? 0, "unexpected height-change").toBe(0);

		cleanup();
	});

	it("multiple card add/remove cycles: no ghost lines in any frame", async () => {
		const { tui, pc, chat, recorder, cleanup } = setup();

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`msg ${i}`, 0, 0));
		pc.setStatus("INSERT");
		pc.startThinking();
		tui.requestRender(true);
		await settle(100);

		for (let cycle = 0; cycle < 5; cycle++) {
			const id = `c${cycle}`;
			const name = `cmd-${cycle}`;
			pc.showInFlightCall(id, "shell.exec", name, {});
			tui.requestRender();
			await settle(100);

			const addSeq = recorder.last!.seq;

			pc.removeInFlightCall(id);
			tui.requestRender();
			await settle(100);

			const ghosts = recorder.ghostLines(name, addSeq);
			expect(ghosts.length, `ghost "${name}" after cycle ${cycle}`).toBe(0);
		}

		pc.stopThinking();
		cleanup();
	});

	it("no duplicate braille lines when card appears during thinking", async () => {
		const { tui, pc, chat, recorder, cleanup } = setup();

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`msg ${i}`, 0, 0));
		pc.startThinking();
		pc.showInFlightCall("e1", "shell.exec", "ls", { command: "ls" });
		tui.requestRender(true);
		await settle(500);

		const dupes = recorder.duplicateLines(BRAILLE_RE);
		expect(
			dupes.length,
			`duplicate braille:\n${dupes
				.map((d) => {
					const lines = d.lines.map((li) => `    ${li}: "${d.frame.stripped[li]}"`).join("\n");
					return `  frame ${d.frame.seq}:\n${lines}`;
				})
				.join("\n")}`,
		).toBe(0);

		pc.removeInFlightCall("e1");
		pc.stopThinking();
		cleanup();
	});
});
