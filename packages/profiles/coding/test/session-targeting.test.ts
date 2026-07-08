/**
 * Honey-pot A/B/C eval.
 *
 * RED: written before the alef.sessions.search content-scan fix.
 * The test WILL FAIL until alef.sessions.search searches turn content,
 * not just firstMessage. That fix is
 *
 * Three sessions:
 * A (current) — TUI spinner animation topic
 * B (target) — Session picker arrow key bug (notifySelectionChange)
 * C (honey-pot) — EditorWrapper width crash (session picker surface vocabulary)
 *
 * The honey-pot C shares "session picker" and "TUI fix" vocabulary with B.
 * A firstMessage-only search returns both B and C. The agent must read
 * session content and discriminate on specific function names.
 *
 * Requires Vertex credentials — skipped when ANTHROPIC_VERTEX_PROJECT_ID absent.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMetaAgent } from "@dpopsuev/alef-agent/meta-agent";
import { JsonlSessionStore } from "@dpopsuev/alef-session/store";

const SKIP =
	(!process.env.ANTHROPIC_VERTEX_PROJECT_ID && !process.env.GOOGLE_CLOUD_PROJECT) || !process.env.ALEF_META_TESTS;

async function writeDialog(store: JsonlSessionStore, pairs: Array<{ user: string; assistant: string }>) {
	for (let i = 0; i < pairs.length; i++) {
		const corrId = `turn-${i}`;
		await store.append({
			bus: "event",
			type: "llm.response",
			correlationId: corrId,
			payload: { text: pairs[i]!.user },
			timestamp: Date.now() + i * 100,
		});
		await store.append({
			bus: "command",
			type: "llm.response",
			correlationId: corrId,
			payload: {
				text: pairs[i]!.assistant,
				conversationHistory: [
					{ role: "user", content: pairs[i]!.user },
					{ role: "assistant", content: pairs[i]!.assistant },
				],
			},
			timestamp: Date.now() + i * 100 + 50,
		});
	}
}

describe.skipIf(SKIP)(
	"meta-agent session targeting — discriminates by content not surface vocabulary",
	{ tags: ["real-llm"] },
	() => {
		let cwd: string;
		let sessionA: JsonlSessionStore;
		let sessionB: JsonlSessionStore;
		let sessionC: JsonlSessionStore;

		beforeAll(async () => {
			cwd = mkdtempSync(join(tmpdir(), "alef-honeypot-"));

			// Session A — current session, irrelevant topic
			sessionA = await JsonlSessionStore.create(cwd);
			await writeDialog(sessionA, [
				{
					user: "How do I make the spinner glyph breathe?",
					assistant:
						"Use a sine wave over elapsed time to modulate the hue. The shiftedAccentAnsi function already does hue rotation — feed elapsedMs into timeBasedHue and you get breathing for free.",
				},
			]);

			// Session B — TARGET: session picker arrow key repaint bug
			sessionB = await JsonlSessionStore.create(cwd);
			await writeDialog(sessionB, [
				{
					user: "The session picker arrows don't work — pressing up and down has no visible effect.",
					assistant:
						"The bug is in SelectList.notifySelectionChange(). It only calls the onSelectionChange callback — it never calls tui.requestRender(). The TUI doesn't know it needs to repaint. Fix: call tui.requestRender() after every list.handleInput(data) in the onRawInput handler of session-picker.ts.",
				},
				{
					user: "Where exactly is notifySelectionChange?",
					assistant:
						"It's at line 218 of packages/tui/src/components/select-list.ts. The method calls this.onSelectionChange?.(selectedItem) but has no reference to the TUI instance. The session-picker.ts owns the TUI and must call requestRender() itself.",
				},
			]);

			// Session C — HONEY-POT: session picker CRASH (shares "session picker" + "TUI" vocabulary)
			sessionC = await JsonlSessionStore.create(cwd);
			await writeDialog(sessionC, [
				{
					user: "The session picker crashed with 'Rendered line 11 exceeds terminal width (180 > 179)'.",
					assistant:
						"The crash is in EditorWrapper.render(). We prepend a space to content lines for alignment, but render the inner editor at full width. The line becomes width+1 chars. Fix: call this.inner.render(Math.max(1, width - 1)) instead of width.",
				},
				{
					user: "Which file?",
					assistant:
						"packages/runner/src/prompt-console.ts, the EditorWrapper class. The render() method at line 10.",
				},
			]);
		});

		afterAll(() => {
			rmSync(cwd, { recursive: true, force: true });
		});

		it("targets session B (notifySelectionChange) not C (EditorWrapper) when asked about arrow key repaint", async () => {
			// Override SESSION_ROOT in adapter-alef to use our temp cwd.
			// The adapter reads from homedir() by default; we need to redirect it.
			// For this test we call runMetaAgent with a prompt and check if it mentions B's ID.
			const prompt =
				`I have sessions in ${cwd}. Find the session where we fixed the bug where ` +
				`arrow keys in the session picker did not update the visible selection. ` +
				`The fix involved a missing requestRender() call and a function called notifySelectionChange. ` +
				`What is the session ID? Reply with just the ID.`;

			const reply = await runMetaAgent(prompt);
			console.log(`\nMeta-agent reply: ${reply}`);
			console.log(`Session B ID: ${sessionB.id}`);
			console.log(`Session C ID (honey-pot): ${sessionC.id}`);

			// The agent must identify B, not C.
			expect(reply).toContain(sessionB.id);
			expect(reply).not.toContain(sessionC.id);
		}, 120_000);
	},
);
