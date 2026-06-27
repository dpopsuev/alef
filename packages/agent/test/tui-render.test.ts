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
import { TUI } from "@dpopsuev/alef-tui";
import { MockTerminal } from "@dpopsuev/alef-tui/mock-terminal";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import "@dpopsuev/alef-coding-agent";

import { parseArgs } from "../src/args.js";
import { buildIdentityContext, createLocalSession } from "../src/cli/local-session.js";
import { JsonlSessionStore } from "../src/session-store.js";

const SILENT_LOGGER = pino({ level: "silent" });

const STUB_STORAGE: StorageFactory = {
	daemonRegistry: () => ({
		register: async () => {},
		unregister: async () => {},
		get: async () => undefined,
		list: async () => [],
		findByCwd: async () => undefined,
		findLatest: async () => undefined,
		prune: async () => 0,
	}),
	summaryStore: () => ({ write: async () => {}, get: async () => undefined, latest: async () => undefined }),
	authStore: () => ({}) as never,
	sessions: {} as never,
};
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

		console.log("output.length:", terminal.output.length);
		console.log(
			"first 3 outputs:",
			terminal.output.slice(0, 3).map((s) => JSON.stringify(s.slice(0, 40))),
		);

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

		console.log("async context output.length:", terminal.output.length);
		expect(terminal.output.length).toBeGreaterThan(0);

		tui.stop();
	});

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

		let renderCount = 0;
		// Instrument session.subscribe to see what events the TUI dispatch receives
		const dispatchedEvents: Array<{ type: string; text?: string }> = [];
		const origSubscribe = session.subscribe.bind(session);
		session.subscribe = (observer: (event: import("../src/session.js").AgentEvent) => void) => {
			return origSubscribe((event: import("../src/session.js").AgentEvent) => {
				const text = "text" in event ? String((event as { text?: string }).text) : undefined;
				dispatchedEvents.push({ type: event.type, text });
				observer(event);
			});
		};

		const { runTuiMode } = await import("../src/cli/tui-mode.js");
		const origWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			renderCount++;
			origWrite(data);
		};
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

		console.log("after runTuiMode, output.length:", terminal.output.length, "renderCount:", renderCount);

		if (terminal.output.length > 0) {
			const outputBefore = terminal.output.length;

			// Send a message
			if (session.send) {
				await session.send("hello", 10_000);
			}

			// Wait for Typewriter ticks (16ms per char, ~20 chars = ~400ms)
			// plus render cycles
			for (let i = 0; i < 20; i++) {
				await new Promise((r) => setTimeout(r, 100));
				if (terminal.stripAnsi().includes("mock terminal reply")) break;
			}

			console.log("outputs after send:", terminal.output.length - outputBefore);
			console.log("total output chars:", terminal.allOutput().length);
			const rendered = terminal.stripAnsi();
			console.log("stripped length:", rendered.length);
			console.log("dispatched events:", JSON.stringify(dispatchedEvents));

			// The Typewriter is not rendering text. Is the problem:
			// A) Typewriter.tick() never fires (setTimeout blocked)
			// B) Markdown.setText() doesn't invalidate the component
			// C) doRender() diff doesn't detect the change
			//
			// To isolate: the faux provider is synchronous. session.send()
			// resolves immediately. The chunk arrives synchronously in the
			// same microtask. The Typewriter.receive() buffers and schedules
			// a setTimeout(tick, 16ms). But session.send() is AWAITED in the
			// test — when it resolves, the current microtask chain is done.
			// The 16ms setTimeout should fire during the next await.
			// Force flush the typewriter by waiting and checking renders
			console.log("all renders after extra wait:", terminal.output.length);
			// Let's check raw output content for ANY text
			const allRaw = terminal.allOutput();
			console.log("raw output contains 'mock':", allRaw.includes("mock"));
			console.log("raw output contains 'reply':", allRaw.includes("reply"));
			console.log("raw output contains 'terminal':", allRaw.includes("terminal"));
			// Check if the Typewriter is still pending
			console.log("waiting 500ms more for typewriter ticks...");
			await new Promise((r) => setTimeout(r, 500));
			console.log("outputs after extra wait:", terminal.output.length - outputBefore);
			const renderedAfterWait = terminal.stripAnsi();
			console.log("contains reply after extra wait:", renderedAfterWait.includes("mock terminal reply"));
			console.log("contains reply:", rendered.includes("mock terminal reply"));
			if (!rendered.includes("mock terminal reply")) {
				// Check if chunks were dispatched
				const chunkCount = dispatchedEvents.filter((e) => e.type === "chunk").length;
				const turnCompleteCount = dispatchedEvents.filter((e) => e.type === "turn-complete").length;
				console.log("chunk events dispatched:", chunkCount);
				console.log("turn-complete events dispatched:", turnCompleteCount);
				console.log("raw last output:", JSON.stringify(terminal.output[terminal.output.length - 1]?.slice(0, 200)));
			}
			expect(rendered).toContain("mock terminal reply");
		} else {
			// Initial render didn't fire — this IS the bug
			expect.fail("BUG: terminal.output is empty after runTuiMode + 200ms — doRender never wrote to terminal");
		}

		session.dispose();
		await Promise.race([tuiDone, new Promise((r) => setTimeout(r, 500))]);
	}, 15_000);
});
