/**
 * Regression: directives must reach the LLM as a system prompt.
 * Without this, the agent runs with zero instructions — no identity, no format rules.
 *
 * Uses the Context Window Reconstructor to verify the context at turn 0.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-llm";
import { buildSessionIndex, reconstructTurn } from "@dpopsuev/alef-session";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import "@dpopsuev/alef-coding-agent";

import { parseArgs } from "../src/args.js";
import { createLocalSession } from "../src/cli/local-session.js";
import { JsonlSessionStore } from "../src/session-store.js";
import { HeadlessViewMode } from "../src/view-mode.js";

const EMPTY_LOADED = {
	adapters: [],
	blueprintModelId: undefined,
	blueprintName: undefined,
	blueprintSurfaces: [],
	blueprintUpgradePolicy: "rebuild_only" as const,
	blueprintPath: undefined,
	writableRoots: undefined,
};

describe("system prompt injection — directives reach the LLM", { tags: ["e2e"] }, () => {
	const tmpDirs: string[] = [];
	afterEach(() => {
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function makeTmp(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-sysprompt-"));
		tmpDirs.push(d);
		return d;
	}

	it("session JSONL contains system prompt with identity and format directives", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("ok")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const logOutput: string[] = [];
		const log = pino(
			{
				level: "info",
				transport: undefined,
			},
			{
				write(msg: string) {
					logOutput.push(msg);
				},
			},
		);
		const args = { ...parseArgs([]), cwd, noTui: true };
		const model = faux.getModel();

		const { session } = await createLocalSession(args, {}, log, store, EMPTY_LOADED, model);

		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);
		await viewer.send("hello");
		viewer.complete();
		await running;

		const directivesLog = logOutput.find((l) => l.includes("directives:built"));
		expect(directivesLog, "directives:built log must be emitted at boot").toBeTruthy();

		const parsed = JSON.parse(directivesLog!) as { blocks: number; chars: number };
		expect(parsed.blocks).toBeGreaterThan(5);
		expect(parsed.chars).toBeGreaterThan(500);

		const records = await store.events();
		const index = buildSessionIndex(records);
		const snapshot = reconstructTurn(index, 0);

		expect(snapshot, "reconstructor must find turn 0").toBeDefined();
		expect(snapshot!.conversationHistory, "turn 0 must have conversation history").toBeDefined();
		expect(snapshot!.messageCount).toBeGreaterThan(0);
	});
});
