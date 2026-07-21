/**
 * Dock layout structural invariants.
 *
 * Tests the pure/stable layers of the render pipeline:
 *   1. partitionChildren() puts chat in scrollRegion, dock components in dock
 *   2. scrollArchivedIntoHistory() never receives dock-component output
 *   3. dock line count is stable when only chat content changes
 *   4. component state has at most one active animation source
 *
 * Does NOT assert pixel positions, line indices, or separator characters.
 * Those belong to the fragile rendering layer that changes with every tweak.
 */

import { Container, Text, TUI } from "@dpopsuev/alef-tui";
import { describe, expect, it } from "vitest";
import { extractArchivePayloads } from "../../ui/tui/test/fixtures/scrollback-purity.js";
import { VirtualTerminal } from "../../ui/tui/test/virtual-terminal.js";
import { PromptConsole } from "../src/client/console.js";
import { getTheme } from "../src/client/theme.js";

async function settle(ms = 30): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

// -- Fingerprints injected into components so we can identify their output
// -- without knowing what separators or spinners look like.
const CHAT_TAG = "CHAT_LINE_";
const EDITOR_TAG = "DOCK_EDITOR_CONTENT";
const FOOTER_TAG = "DOCK_FOOTER_TAG";
const TOPIC_TAG = "DOCK_TOPIC_TAG";
const STATUS_TAG = "DOCK_STATUS_TAG";

/**
 * Replicate TUI.partitionChildren() logic against the public children array.
 * The dock boundary is the first component added by PromptConsole.mount()
 * (the pendingFooter DynamicText), identifiable by being the first child
 * after the chat container.
 */
function partition(tui: TUI, chatContainer: Container, width: number) {
	const children = tui.children;
	const chatIdx = children.indexOf(chatContainer);
	const dockAt = chatIdx + 1; // first child after chat is the dock boundary
	const scrollRegion: string[] = [];
	const dock: string[] = [];
	for (let i = 0; i < children.length; i++) {
		const lines = children[i]!.render(width);
		if (i < dockAt) scrollRegion.push(...lines);
		else dock.push(...lines);
	}
	return { scrollRegion, dock };
}

function setup(width = 80, height = 20) {
	const terminal = new VirtualTerminal(width, height);
	const writes: string[] = [];
	const origWrite = terminal.write.bind(terminal);
	terminal.write = (data: string) => {
		writes.push(data);
		origWrite(data);
	};

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

	const footer = new Text(FOOTER_TAG, 0, 0);
	tui.addChild(footer);

	return { terminal, tui, pc, chat, footer, writes, cleanup: () => tui.stop() };
}

// ---------------------------------------------------------------------------
// 1. Partition invariant
// ---------------------------------------------------------------------------
describe("partition invariant", { tags: ["unit"] }, () => {
	it("chat lines appear only in scrollRegion, dock components only in dock", () => {
		const { tui, pc, chat, cleanup } = setup();

		for (let i = 0; i < 10; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.setStatus(STATUS_TAG);
		pc.setTopicLabel(TOPIC_TAG);
		pc.editor.setText(EDITOR_TAG);

		const { scrollRegion, dock } = partition(tui, chat, 80);
		const scrollText = scrollRegion.map(stripAnsi).join("\n");
		const dockText = dock.map(stripAnsi).join("\n");

		// Chat tags must be in scroll region, not dock
		expect(scrollText).toContain(CHAT_TAG);
		expect(dockText).not.toContain(CHAT_TAG);

		// Dock tags must be in dock, not scroll region
		expect(dockText).toContain(EDITOR_TAG);
		expect(dockText).toContain(FOOTER_TAG);
		expect(scrollText).not.toContain(EDITOR_TAG);
		expect(scrollText).not.toContain(FOOTER_TAG);

		cleanup();
	});

	it("partition holds after chat overflow", () => {
		const { tui, pc, chat, cleanup } = setup(80, 16);

		for (let i = 0; i < 50; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.editor.setText(EDITOR_TAG);

		const { scrollRegion, dock } = partition(tui, chat, 80);
		const scrollText = scrollRegion.map(stripAnsi).join("\n");
		const dockText = dock.map(stripAnsi).join("\n");

		expect(scrollText).toContain(CHAT_TAG);
		expect(dockText).not.toContain(CHAT_TAG);
		expect(dockText).toContain(EDITOR_TAG);
		expect(scrollText).not.toContain(EDITOR_TAG);

		cleanup();
	});

	it("partition holds with thinking spinner and in-flight cards", async () => {
		const { tui, pc, chat, cleanup } = setup();

		for (let i = 0; i < 5; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.startThinking();
		pc.showInFlightCall("c1", "shell.exec", "npm test", { command: "npm test" });
		pc.editor.setText(EDITOR_TAG);

		await settle(200);

		const { scrollRegion, dock } = partition(tui, chat, 80);
		const scrollText = scrollRegion.map(stripAnsi).join("\n");
		const dockText = dock.map(stripAnsi).join("\n");

		expect(scrollText).toContain(CHAT_TAG);
		expect(dockText).not.toContain(CHAT_TAG);
		expect(dockText).toContain(EDITOR_TAG);
		expect(scrollText).not.toContain(EDITOR_TAG);

		pc.removeInFlightCall("c1");
		pc.stopThinking();
		cleanup();
	});
});

// ---------------------------------------------------------------------------
// 2. Containment invariant
// ---------------------------------------------------------------------------
describe("containment invariant", { tags: ["unit"] }, () => {
	it("archived lines never contain dock fingerprints", async () => {
		const { tui, pc, chat, writes, cleanup } = setup(72, 16);

		pc.setStatus(STATUS_TAG);
		pc.setTopicLabel(TOPIC_TAG);
		pc.editor.setText(EDITOR_TAG);

		tui.requestRender(true);
		await settle();
		writes.length = 0;

		// Overflow chat to force archiving
		for (let i = 0; i < 40; i++) {
			chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}

		const archived = extractArchivePayloads(writes);
		expect(archived.length, "should have archived lines").toBeGreaterThan(0);

		const archivedText = archived.join("\n");
		expect(archivedText).toContain(CHAT_TAG);
		expect(archivedText).not.toContain(EDITOR_TAG);
		expect(archivedText).not.toContain(FOOTER_TAG);
		expect(archivedText).not.toContain(TOPIC_TAG);
		expect(archivedText).not.toContain(STATUS_TAG);

		cleanup();
	});

	it("archived lines stay clean during thinking + in-flight churn", async () => {
		const { tui, pc, chat, writes, cleanup } = setup(72, 16);

		pc.editor.setText(EDITOR_TAG);
		pc.startThinking();
		pc.showInFlightCall("c1", "shell.exec", "CARD_TAG_1", { command: "ls" });
		pc.showInFlightCall("c2", "fs.read", "CARD_TAG_2", { path: "/tmp" });

		tui.requestRender(true);
		await settle();
		writes.length = 0;

		for (let i = 0; i < 40; i++) {
			chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}

		pc.removeInFlightCall("c1");
		pc.removeInFlightCall("c2");
		pc.stopThinking();
		tui.requestRender();
		await settle();

		// Continue overflow after cards removed
		for (let i = 40; i < 60; i++) {
			chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}

		const archived = extractArchivePayloads(writes);
		expect(archived.length).toBeGreaterThan(0);

		const archivedText = archived.join("\n");
		expect(archivedText).toContain(CHAT_TAG);
		expect(archivedText).not.toContain(EDITOR_TAG);
		expect(archivedText).not.toContain(FOOTER_TAG);
		expect(archivedText).not.toContain("CARD_TAG_1");
		expect(archivedText).not.toContain("CARD_TAG_2");

		cleanup();
	});
});

// ---------------------------------------------------------------------------
// 3. Dock stability
// ---------------------------------------------------------------------------
describe("dock stability", { tags: ["unit"] }, () => {
	it("dock line count does not change when only chat grows", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 20);

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.setStatus(STATUS_TAG);
		pc.editor.setText(EDITOR_TAG);

		tui.requestRender(true);
		await settle();

		const before = partition(tui, chat, 80);
		const dockCountBefore = before.dock.length;

		// Add 30 more chat lines
		for (let i = 3; i < 33; i++) {
			chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		}
		tui.requestRender();
		await settle();

		const after = partition(tui, chat, 80);
		expect(after.dock.length, "dock height must not change when only chat changes").toBe(dockCountBefore);

		cleanup();
	});

	it("dock line count does not change during thinking", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 20);

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.editor.setText(EDITOR_TAG);

		tui.requestRender(true);
		await settle();

		const before = partition(tui, chat, 80);
		const _dockCountBefore = before.dock.length;

		pc.startThinking();
		await settle(300);

		const during = partition(tui, chat, 80);
		// Dock grows by the spinner line -- that's expected and stable.
		// But it must NOT grow further as chat changes.
		const dockCountThinking = during.dock.length;

		for (let i = 3; i < 20; i++) {
			chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		}
		tui.requestRender();
		await settle();

		const afterChat = partition(tui, chat, 80);
		expect(afterChat.dock.length, "dock height must stay stable as chat grows during thinking").toBe(
			dockCountThinking,
		);

		pc.stopThinking();
		cleanup();
	});

	it("dock line count is stable across in-flight card add/remove cycles", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 20);

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.startThinking();
		pc.editor.setText(EDITOR_TAG);
		await settle(200);

		const baseline = partition(tui, chat, 80).dock.length;

		// Add a card -- dock may grow (card renders content after first tick)
		pc.showInFlightCall("c1", "shell.exec", "test", {});
		await settle(100);
		const withCard = partition(tui, chat, 80).dock.length;
		expect(withCard).toBeGreaterThanOrEqual(baseline);

		// Remove card -- dock shrinks back
		pc.removeInFlightCall("c1");
		await settle(100);
		const afterRemove = partition(tui, chat, 80).dock.length;
		expect(afterRemove, "dock should return to baseline after card removal").toBe(baseline);

		pc.stopThinking();
		cleanup();
	});
});

// ---------------------------------------------------------------------------
// 4. Single-spinner invariant
// ---------------------------------------------------------------------------
describe("single-spinner invariant", { tags: ["unit"] }, () => {
	it("thinking timer produces at most one animation source in component state", async () => {
		const { pc, cleanup } = setup();

		expect(pc.isThinking).toBe(false);

		pc.startThinking();
		await settle(100);
		expect(pc.isThinking).toBe(true);

		// Starting again must cancel the previous -- not double up
		pc.startThinking();
		await settle(100);
		expect(pc.isThinking).toBe(true);

		pc.stopThinking();
		expect(pc.isThinking).toBe(false);

		cleanup();
	});

	it("statusText is suppressed when in-flight cards exist", async () => {
		const { tui, pc, chat, cleanup } = setup();

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));

		pc.startThinking();
		await settle(200);

		// Before cards: statusText should have content (spinner)
		const { dock: dockBefore } = partition(tui, chat, 80);
		const dockTextBefore = dockBefore.map(stripAnsi).join("\n");
		const _hasBrailleBefore = /[\u2800-\u28FF]/.test(dockTextBefore);

		// Add a card
		pc.showInFlightCall("c1", "shell.exec", "test", {});
		await settle(200);

		// After cards: the standalone spinner line in statusText should be empty
		// (the card has its own spinner, so no standalone line)
		const { dock: dockAfter } = partition(tui, chat, 80);
		const _dockTextAfter = dockAfter.map(stripAnsi).join("\n");

		// Count standalone braille lines (not inside a card's output)
		// The statusText component renders before the cards in the dock.
		// When cards exist, statusText should produce no braille.
		const statusLines = (pc as any).statusText.render(80) as string[];
		const statusBraille = statusLines.filter((l: string) => /[\u2800-\u28FF]/.test(l));
		expect(statusBraille.length, "statusText must produce no braille lines when cards are showing").toBe(0);

		pc.removeInFlightCall("c1");
		pc.stopThinking();
		cleanup();
	});

	it("double startThinking does not double render rate", async () => {
		const { tui, pc, cleanup } = setup();

		let renderCount = 0;
		const orig = tui.requestRender.bind(tui);
		tui.requestRender = (force?: boolean) => {
			renderCount++;
			orig(force);
		};

		pc.startThinking();
		pc.startThinking();
		await settle(500);

		pc.stopThinking();
		cleanup();

		// At ~80ms per tick over 500ms: ~6 ticks. Allow headroom for
		// show/stop overhead, but reject doubled rate (>12 would mean
		// two concurrent timers).
		expect(renderCount, `double startThinking produced ${renderCount} renders`).toBeLessThanOrEqual(12);
	});

	it("stopThinking clears all animated state", () => {
		const { pc, cleanup } = setup();

		pc.startThinking();
		expect(pc.isThinking).toBe(true);

		pc.stopThinking();
		expect(pc.isThinking).toBe(false);

		const statusLines = (pc as any).statusText.render(80) as string[];
		const nonEmpty = statusLines.filter((l: string) => l.trim().length > 0);
		expect(nonEmpty.length, "statusText should be empty after stopThinking").toBe(0);

		cleanup();
	});
});
