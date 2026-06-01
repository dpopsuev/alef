/**
 * SessionSummary — written at agent exit (ALE-TSK-276 / Djinn pattern).
 *
 * Verifies that two files are written when the agent disposes:
 *   <session-dir>/<id>.summary.json   — per-session archive
 *   ~/.alef/last-session.json         — always overwritten
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai";
import { Agent } from "@dpopsuev/alef-corpus";
import { afterEach, describe, expect, it } from "vitest";
import { DialogOrgan } from "../../organ-dialog/src/organ.js";
import { Cerebrum } from "../../organ-llm/src/index.js";
import { SessionLog, type SessionSummary } from "../src/event-log-organ.js";
import { SessionStore } from "../src/session-store.js";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});

function makeTmp(): string {
	const d = join(tmpdir(), `alef-summary-test-${Date.now()}`);
	tmps.push(d);
	return d;
}

describe("SessionSummary (ALE-TSK-276)", () => {
	it("writes per-session and last-session summary on agent dispose", async () => {
		const cwd = makeTmp();
		await mkdir(cwd, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("done")]);

		const store = await SessionStore.create(cwd);
		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {} });
		const log = new SessionLog(store, "test-model");
		agent
			.load(dialog)
			.load(new Cerebrum({ model: faux.getModel(), apiKey: "faux-key" }))
			.load(log);

		await dialog.send("hello", "user", 10_000);
		agent.dispose();

		// Give async writes a tick to settle.
		await new Promise((r) => setTimeout(r, 50));

		const perSession = store.path.replace(/\.jsonl$/, ".summary.json");
		const raw = await readFile(perSession, "utf-8");
		const summary = JSON.parse(raw) as SessionSummary;

		expect(summary.id).toBe(store.id);
		expect(summary.model).toBe("test-model");
		expect(summary.turns).toBeGreaterThanOrEqual(1);
		expect(summary.tokens).toBeDefined();
		expect(Array.isArray(summary.tools)).toBe(true);
		expect(summary.duration_ms).toBeGreaterThan(0);

		// last-session.json is global state — only verify it exists, not its content
		// (concurrent tests write it simultaneously; content is inherently racy).
		const last = join(homedir(), ".alef", "last-session.json");
		const lastExists = await readFile(last, "utf-8")
			.then(() => true)
			.catch(() => false);
		expect(lastExists).toBe(true);
	});
});
