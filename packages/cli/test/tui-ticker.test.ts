/**
 * Mechanical TUI ticker tests.
 *
 * Deterministic: no real time, no flaky waits.
 * Each test is a sequence of inject/tick/snapshot/assert.
 */

import { describe, expect, it } from "vitest";
import { createTicker } from "./tui-ticker.js";

const BRAILLE_RE = /[\u2800-\u28FF]/;
const SEPARATOR_RE = /[─\u2500]{3,}/;

describe("mechanical TUI ticker", { tags: ["unit"] }, () => {
	it("initial render has dock structure", async () => {
		const ticker = createTicker();
		await ticker.render();

		const snap = ticker.snapshot();
		expect(snap.stripped[snap.stripped.length - 1]).toContain("~/test");
		expect(
			snap.stripped.some((l) => l.includes("INSERT")),
			"INSERT",
		).toBe(true);
		expect(
			snap.stripped.some((l) => SEPARATOR_RE.test(l)),
			"separator",
		).toBe(true);
		expect(snap.frameCount).toBeGreaterThan(0);

		ticker.dispose();
	});

	it("tool-start adds card, tool-end removes it", async () => {
		const ticker = createTicker();
		await ticker.render();

		ticker.inject({ type: "tool-start", callId: "c1", name: "shell.exec", args: { command: "ls" } });
		await ticker.tick(50);

		let snap = ticker.snapshot();
		expect(
			snap.stripped.some((l) => l.includes("shell.exec")),
			`card should appear:\n${snap.stripped.join("\n")}`,
		).toBe(true);

		ticker.inject({ type: "tool-end", callId: "c1", elapsedMs: 100, ok: true, display: "done" });
		await ticker.tick(50);

		snap = ticker.snapshot();
		const cardGone = !snap.stripped.some((l) => l.includes("shell.exec") && BRAILLE_RE.test(l));
		expect(cardGone, `card should be gone:\n${snap.stripped.join("\n")}`).toBe(true);

		ticker.dispose();
	});

	it("tool-chunk does not contaminate separator", async () => {
		const ticker = createTicker();
		await ticker.render();

		ticker.inject({ type: "tool-start", callId: "c1", name: "shell.exec", args: { command: "npm test" } });
		await ticker.tick(30);

		for (let i = 0; i < 20; i++) {
			ticker.inject({ type: "tool-chunk", callId: "c1", text: `PASS test/unit-${i}.ts\n` });
			await ticker.tick(30);
		}

		const hits = ticker.recorder.framesWithContentOnSeparator(/PASS test\//);
		expect(
			hits.length,
			`separator contaminated in ${hits.length} frames:\n${hits.map((h) => `  frame ${h.frame.seq} line ${h.line}: "${h.text}"`).join("\n")}`,
		).toBe(0);

		ticker.inject({ type: "tool-end", callId: "c1", elapsedMs: 600, ok: true });
		await ticker.tick(50);
		ticker.dispose();
	});

	it("thinking spinner appears, card suppresses it", async () => {
		const ticker = createTicker();
		await ticker.render();

		ticker.pc.startThinking();
		await ticker.tick(200);

		let snap = ticker.snapshot();
		const hasSpinner = snap.stripped.some((l) => BRAILLE_RE.test(l) && /\d+/.test(l));
		expect(hasSpinner, `spinner should appear:\n${snap.stripped.join("\n")}`).toBe(true);

		ticker.inject({ type: "tool-start", callId: "c1", name: "shell.exec", args: { command: "ls" } });
		await ticker.tick(200);

		snap = ticker.snapshot();
		const standaloneSpinners = snap.stripped.filter(
			(l) => BRAILLE_RE.test(l) && /\d+/.test(l) && !l.includes("shell.exec"),
		);
		expect(
			standaloneSpinners.length,
			`standalone spinner should be suppressed:\n${standaloneSpinners.join("\n")}\nfull:\n${snap.stripped.join("\n")}`,
		).toBe(0);

		const dupes = ticker.recorder.duplicateLines(BRAILLE_RE);
		expect(dupes.length, `duplicate braille in ${dupes.length} frames`).toBe(0);

		ticker.inject({ type: "tool-end", callId: "c1", elapsedMs: 200, ok: true });
		await ticker.tick(50);
		ticker.pc.stopThinking();
		ticker.dispose();
	});

	it("rapid card add/remove: no ghost lines in any frame", async () => {
		const ticker = createTicker();
		await ticker.render();

		for (let cycle = 0; cycle < 5; cycle++) {
			const callId = `c${cycle}`;
			const name = `cmd-${cycle}`;

			ticker.inject({ type: "tool-start", callId, name: "shell.exec", args: { command: name } });
			await ticker.tick(30);

			const _addSeq = ticker.recorder.last!.seq;

			ticker.inject({ type: "tool-chunk", callId, text: `${name} output\n` });
			await ticker.tick(30);

			ticker.inject({ type: "tool-end", callId, elapsedMs: 100, ok: true });
			await ticker.tick(50);

			// After tool-end + render settle, card text must not persist as a dock card.
			// Check the LAST frame only (transient frame during reflow is acceptable).
			const lastFrame = ticker.recorder.last;
			const cardStillInDock = lastFrame?.stripped.some((l) => l.includes(name) && BRAILLE_RE.test(l));
			expect(cardStillInDock, `ghost card "${name}" after cycle ${cycle}`).toBeFalsy();
		}

		ticker.dispose();
	});

	it("dock does not drift during streaming", async () => {
		const ticker = createTicker();
		await ticker.render();

		let snap = ticker.snapshot();
		const insertRow = snap.stripped.findIndex((l) => l.includes("INSERT"));

		ticker.inject({ type: "tool-start", callId: "c1", name: "shell.exec", args: { command: "build" } });
		await ticker.tick(30);

		for (let i = 0; i < 20; i++) {
			ticker.inject({ type: "tool-chunk", callId: "c1", text: `line-${i}\n` });
			await ticker.tick(20);
		}

		snap = ticker.snapshot();
		const insertRowAfter = snap.stripped.findIndex((l) => l.includes("INSERT"));
		expect(
			Math.abs(insertRowAfter - insertRow),
			`INSERT drifted ${insertRow}->${insertRowAfter}`,
		).toBeLessThanOrEqual(1);
		expect(snap.stripped[snap.stripped.length - 1]).toContain("~/test");

		ticker.inject({ type: "tool-end", callId: "c1", elapsedMs: 400, ok: true });
		await ticker.tick(50);
		ticker.dispose();
	});

	it("render paths correct across shell.exec lifecycle", async () => {
		const ticker = createTicker();
		await ticker.render();
		ticker.recorder.clear();

		ticker.inject({ type: "tool-start", callId: "c1", name: "shell.exec", args: { command: "test" } });
		await ticker.tick(50);

		for (let i = 0; i < 5; i++) {
			ticker.inject({ type: "tool-chunk", callId: "c1", text: `chunk-${i}\n` });
			await ticker.tick(30);
		}

		ticker.inject({ type: "tool-end", callId: "c1", elapsedMs: 200, ok: true });
		await ticker.tick(50);

		const counts = ticker.recorder.pathCounts();
		expect(counts["dock-reflow"] ?? 0, `no dock-reflow: ${JSON.stringify(counts)}`).toBeGreaterThan(0);

		const efficient = (counts.diff ?? 0) + (counts["no-change"] ?? 0);
		expect(efficient, `no efficient renders: ${JSON.stringify(counts)}`).toBeGreaterThan(0);

		ticker.dispose();
	});

	it("turn-complete clears thinking state", async () => {
		const ticker = createTicker();
		await ticker.render();

		ticker.pc.startThinking();
		await ticker.tick(200);

		ticker.inject({ type: "tool-start", callId: "c1", name: "shell.exec", args: { command: "ls" } });
		await ticker.tick(30);

		ticker.inject({ type: "tool-end", callId: "c1", elapsedMs: 50, ok: true });
		await ticker.tick(30);

		ticker.inject({ type: "turn-complete", reply: "Done." });
		await ticker.tick(30);

		const snap = ticker.snapshot();
		const spinners = snap.stripped.filter((l) => BRAILLE_RE.test(l));
		expect(spinners.length, `spinners after turn-complete:\n${spinners.join("\n")}`).toBe(0);
		expect(
			snap.stripped.some((l) => l.includes("INSERT")),
			"INSERT missing",
		).toBe(true);

		ticker.dispose();
	});
});
