/**
 * TUI round-trip tests via tmux — verifies message → LLM → bus → observer → TUI render.
 *
 * Two modes:
 *   1. Scripted (default): ALEF_SCRIPTED_REPLIES, runs in CI.
 *   2. Live (ALEF_TEST_LLM=1): real LLM, reproduces timing-sensitive hangs.
 *
 * When a hang occurs, the test captures the tmux pane and trace log for diagnostics.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmuxHarness, type TmuxHarness } from "@dpopsuev/alef-testkit/tmux-harness";
import { afterEach, describe, expect, it } from "vitest";

const HAS_TMUX = spawnSync("which", ["tmux"]).status === 0;
const HAS_REAL_LLM = process.env.ALEF_TEST_LLM === "1";
const REPLY_MARKER = "round-trip-ok-7f3a";
const RENDER_SETTLE_MS = 3_000;

const tmps: string[] = [];
const harnesses: TmuxHarness[] = [];

function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-rt-"));
	tmps.push(d);
	return d;
}

afterEach(() => {
	for (const h of harnesses.splice(0)) h.kill();
	for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function collectDiagnostics(harness: TmuxHarness): string {
	const pane = harness.capture();
	let frames = "";
	try {
		frames = readFileSync("/tmp/alef-frames.jsonl", "utf-8").split("\n").slice(-5).join("\n");
	} catch {
		// no frames file
	}
	return ["=== TMUX PANE ===", pane, "=== LAST 5 FRAMES ===", frames || "(none)"].join("\n");
}

const suite = HAS_TMUX ? describe : describe.skip;

suite("TUI round-trip — scripted", { tags: ["integration"] }, () => {
	it("plain text reply appears in TUI", async () => {
		const cwd = makeTmp();
		const harness = await createTmuxHarness({
			cwd,
			replies: [REPLY_MARKER],
			timeoutMs: 20_000,
		});
		harnesses.push(harness);

		harness.type("Hello");
		await new Promise((r) => setTimeout(r, RENDER_SETTLE_MS));

		let pane: string;
		try {
			pane = await harness.waitFor(new RegExp(REPLY_MARKER), 15_000);
		} catch {
			const diag = collectDiagnostics(harness);
			throw new Error(`TUI hang detected — reply marker never appeared.\n${diag}`);
		}

		expect(pane).toContain(REPLY_MARKER);
	}, 45_000);

	it("tool-call reply appears after tool execution", async () => {
		const cwd = makeTmp();
		const steps = [
			{
				kind: "toolCall" as const,
				call: { name: "fs.find", args: { path: cwd, pattern: "*" } },
				reply: REPLY_MARKER,
			},
		];
		const harness = await createTmuxHarness({
			cwd,
			replies: steps,
			timeoutMs: 20_000,
		});
		harnesses.push(harness);

		harness.type("explore");
		await new Promise((r) => setTimeout(r, RENDER_SETTLE_MS));

		try {
			await harness.waitFor(/fs\.find/, 15_000);
		} catch {
			const diag = collectDiagnostics(harness);
			throw new Error(`TUI hang detected — tool pill never appeared.\n${diag}`);
		}

		let pane: string;
		try {
			pane = await harness.waitFor(new RegExp(REPLY_MARKER), 15_000);
		} catch {
			const diag = collectDiagnostics(harness);
			throw new Error(`TUI hang detected — reply marker never appeared after tool.\n${diag}`);
		}

		expect(pane).toContain(REPLY_MARKER);
	}, 60_000);
});

const liveSuite = HAS_TMUX && HAS_REAL_LLM ? describe : describe.skip;

liveSuite("TUI round-trip — live LLM", { tags: ["real-llm"] }, () => {
	it("real LLM reply renders in TUI without hanging", async () => {
		const cwd = makeTmp();
		const harness = await createTmuxHarness({
			cwd,
			timeoutMs: 30_000,
		});
		harnesses.push(harness);

		harness.type(`Say exactly this and nothing else: ${REPLY_MARKER}`);

		let pane: string;
		try {
			pane = await harness.waitFor(new RegExp(REPLY_MARKER), 60_000);
		} catch {
			const diag = collectDiagnostics(harness);
			throw new Error(
				`TUI hang detected with real LLM — reply never appeared.\n` +
					`This reproduces the G4 bug (Scribe 340a).\n${diag}`,
			);
		}

		expect(pane).toContain(REPLY_MARKER);
	}, 90_000);
});
