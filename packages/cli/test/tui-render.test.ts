/**
 * TUI render pipeline E2E test with MockTerminal.
 *
 * Tests the ACTUAL render path: session events → TUI dispatch →
 * requestRender() → doRender() → terminal.write().
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import { createInMemoryStorage } from "@dpopsuev/alef-testkit";
import { TUI } from "@dpopsuev/alef-tui";
import { MockTerminal } from "@dpopsuev/alef-tui/mock-terminal";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import "@dpopsuev/alef-coding-agent";

import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import { DiscourseStore } from "@dpopsuev/alef-tool-discourse";
import { parseArgs } from "../src/boot/args.js";
import { buildIdentityContext, createLocalSession } from "../src/boot/session.js";

const SILENT_LOGGER = pino({ level: "silent" });

const STUB_STORAGE: StorageFactory = createInMemoryStorage();
const EMPTY_LOADED = {
	adapters: [],
	blueprintModelId: undefined,
	blueprintName: undefined,
	blueprintSurfaces: [],
	blueprintUpgradePolicy: "rebuild_only" as const,
	blueprintPath: undefined,
	writableRoots: undefined,
};

describe("TUI render pipeline with MockTerminal", { tags: ["unit"] }, () => {
	const tmpDirs: string[] = [];

	afterEach(() => {
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function makeTmp(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-tui-render-"));
		tmpDirs.push(d);
		return d;
	}

	it("TUI.requestRender writes to MockTerminal (isolated)", async () => {
		const terminal = new MockTerminal(80, 24);
		const tui = new TUI(terminal);

		tui.start();
		tui.requestRender();

		// Wait for process.nextTick → scheduleRender → setTimeout(doRender)
		await new Promise((r) => setTimeout(r, 100));

		// TUI should have rendered SOMETHING (even an empty frame writes cursor positioning)
		expect(terminal.output.length).toBeGreaterThan(0);

		tui.stop();
	});

	it("TUI.requestRender works inside an async function (like runTuiMode)", async () => {
		const terminal = new MockTerminal(80, 24);
		const tui = new TUI(terminal);

		// Simulate what runTuiMode does: async setup, then start + requestRender
		await new Promise((r) => setTimeout(r, 10)); // simulate async buildLayout

		tui.start();
		tui.requestRender();

		// Wait for render
		await new Promise((r) => setTimeout(r, 100));

		expect(terminal.output.length).toBeGreaterThan(0);

		tui.stop();
	});

	it("diagnoses the TUI hang — observer chain delivers events", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("diag-reply-text")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs([]), cwd, noTui: false };
		const model = faux.getModel();

		const { session } = await createLocalSession(
			args,
			{},
			SILENT_LOGGER,
			store,
			EMPTY_LOADED,
			model,
			STUB_STORAGE,
			buildIdentityContext(store),
		);

		const events: string[] = [];
		session.subscribe((event) => {
			events.push(event.type);
		});

		if (session.send) {
			await session.send("hello", 10_000);
		}

		expect(events).toContain("chunk");
		expect(events).toContain("turn-complete");
	}, 15_000);

	it("diagnoses the TUI hang — keyboard-driven submit through MockTerminal", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("render-test-marker")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs([]), cwd, noTui: false };
		const model = faux.getModel();

		const { session } = await createLocalSession(
			args,
			{},
			SILENT_LOGGER,
			store,
			EMPTY_LOADED,
			model,
			STUB_STORAGE,
			buildIdentityContext(store),
		);

		const terminal = new MockTerminal(120, 40);
		const { runTuiMode } = await import("../src/client/runner.js");
		const tuiDone = runTuiMode(session, {
			cwd: args.cwd,
			modelId: "faux/test",
			sessionId: store.id,
			contextWindow: model.contextWindow,
			getModel: () => model.id,
			setModel: () => {},
			getThinking: () => "off",
			setThinking: () => {},
			terminal,
		});

		for (let i = 0; i < 40; i++) {
			await new Promise((r) => setTimeout(r, 100));
			if (terminal.output.length > 0) break;
		}

		for (const ch of "hello") terminal.simulateInput(ch);
		terminal.simulateInput("\r");

		for (let i = 0; i < 80; i++) {
			await new Promise((r) => setTimeout(r, 100));
			if (terminal.stripAnsi().includes("render-test-marker")) break;
		}

		session.dispose();
		await Promise.race([tuiDone, new Promise((r) => setTimeout(r, 500))]);

		const content = terminal.stripAnsi();
		const lastFrame = terminal.output[terminal.output.length - 1] ?? "";
		const lastStripped = lastFrame.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
		expect(
			content,
			`writes=${terminal.output.length}, last frame (${lastStripped.length} chars): "${lastStripped.slice(0, 200)}"`,
		).toContain("render-test-marker");
	}, 15_000);

	it("context window updates in status bar after state-changed event", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("ctx-test")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs([]), cwd, noTui: false };
		const model = faux.getModel();

		const { session } = await createLocalSession(
			args,
			{},
			SILENT_LOGGER,
			store,
			EMPTY_LOADED,
			model,
			STUB_STORAGE,
			buildIdentityContext(store),
		);

		const terminal = new MockTerminal(120, 40);
		const { runTuiMode } = await import("../src/client/runner.js");
		const tuiDone = runTuiMode(session, {
			cwd: args.cwd,
			modelId: "faux/test",
			sessionId: store.id,
			contextWindow: model.contextWindow,
			getModel: () => model.id,
			setModel: () => {},
			getThinking: () => "off",
			setThinking: () => {},
			terminal,
		});

		for (let i = 0; i < 40; i++) {
			await new Promise((r) => setTimeout(r, 100));
			if (terminal.output.length > 0) break;
		}

		const beforeContent = terminal.stripAnsi();
		expect(beforeContent).toContain("128k");

		session.setModel("claude-opus-4-6");

		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 100));
			if (terminal.stripAnsi().includes("1000k") || terminal.stripAnsi().includes("1.0M")) break;
		}

		session.dispose();
		await Promise.race([tuiDone, new Promise((r) => setTimeout(r, 500))]);

		const afterContent = terminal.stripAnsi();
		expect(afterContent, "status bar should show updated context window after model switch").toMatch(/1000k|1\.0M/);
	}, 15_000);

	it("renders LLM response text to terminal after message round-trip", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("mock terminal reply")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs([]), cwd, noTui: false };
		const model = faux.getModel();

		const { session } = await createLocalSession(
			args,
			{},
			SILENT_LOGGER,
			store,
			EMPTY_LOADED,
			model,
			STUB_STORAGE,
			buildIdentityContext(store),
		);

		const terminal = new MockTerminal(120, 40);

		const { runTuiMode } = await import("../src/client/runner.js");
		const tuiDone = runTuiMode(session, {
			cwd: args.cwd,
			modelId: "faux/test",
			sessionId: store.id,
			contextWindow: model.contextWindow,
			getModel: () => model.id,
			setModel: () => {},
			getThinking: () => "off",
			setThinking: () => {},
			terminal,
		});

		// Wait for buildLayout + splash render + initial render
		// buildLayout is async (font rasterization), may take >200ms
		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 100));
			if (terminal.output.length > 0) break;
		}

		if (terminal.output.length > 0) {
			if (session.send) {
				await session.send("hello", 10_000);
			}

			for (let i = 0; i < 20; i++) {
				await new Promise((r) => setTimeout(r, 100));
				if (terminal.stripAnsi().includes("mock terminal reply")) break;
			}

			expect(terminal.stripAnsi()).toContain("mock terminal reply");
		} else {
			// Initial render didn't fire — this IS the bug
			expect.fail("BUG: terminal.output is empty after runTuiMode + 200ms — doRender never wrote to terminal");
		}

		session.dispose();
		await Promise.race([tuiDone, new Promise((r) => setTimeout(r, 500))]);
	}, 15_000);

	it("reloads discourse content when the active discussion thread changes", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("unused")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs([]), cwd, noTui: false };
		const model = faux.getModel();

		const { session } = await createLocalSession(
			args,
			{},
			SILENT_LOGGER,
			store,
			EMPTY_LOADED,
			model,
			STUB_STORAGE,
			buildIdentityContext(store),
		);

		const discourse = new DiscourseStore(cwd);
		const forumId = session.getDiscussion?.()?.forumId ?? "forum";
		discourse.append(forumId, "review", "@reviewer", "review loaded");

		const terminal = new MockTerminal(120, 40);
		const { runTuiMode } = await import("../src/client/runner.js");
		const tuiDone = runTuiMode(session, {
			cwd: args.cwd,
			modelId: "faux/test",
			sessionId: store.id,
			contextWindow: model.contextWindow,
			getModel: () => model.id,
			setModel: () => {},
			getThinking: () => "off",
			setThinking: () => {},
			terminal,
			discussion: session.state.discussion?.active,
		});

		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 100));
			if (terminal.output.length > 0) break;
		}

		session.setDiscussion?.({ topicId: "review", topicTitle: "review" });

		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 100));
			if (terminal.stripAnsi().includes("review loaded")) break;
		}

		session.dispose();
		await Promise.race([tuiDone, new Promise((r) => setTimeout(r, 500))]);

		expect(terminal.stripAnsi()).toContain("review loaded");
	}, 15_000);
});
