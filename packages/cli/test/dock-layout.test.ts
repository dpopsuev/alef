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
import { DockConsole } from "../src/client/console.js";
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
 * The dock boundary is the first component added by DockConsole.mount()
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

	const pc = new DockConsole(tui, getTheme(), "test-model");
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
// 2b. Card removal render purity — separator line must never contain card content
// ---------------------------------------------------------------------------
describe("card removal render purity", { tags: ["unit"] }, () => {
	it("separator line contains no agent card content after card removal", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 24);

		for (let i = 0; i < 5; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.startThinking();
		pc.showInFlightCall("c1", "agent.run", "explore", { text: "AGENT_CARD_FINGERPRINT" });
		await settle(200);

		// Verify card content appears in dock before removal
		const beforePartition = partition(tui, chat, 80);
		const dockTextBefore = beforePartition.dock.map(stripAnsi).join("\n");
		expect(dockTextBefore).toContain("agent.run");

		// Remove the card
		pc.removeInFlightCall("c1");
		tui.requestRender();
		await settle(100);

		// Get the rendered frame from the partition
		const afterPartition = partition(tui, chat, 80);
		const dockLines = afterPartition.dock.map(stripAnsi);

		// Find the separator line(s) — they consist entirely of box-drawing characters and labels
		const separatorPattern = /^[\u2500-\u257F\s-]+/;
		for (const line of dockLines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			if (separatorPattern.test(trimmed)) {
				expect(trimmed).not.toContain("agent.run");
				expect(trimmed).not.toContain("AGENT_CARD_FINGERPRINT");
			}
		}

		// Also verify the card content is completely gone from the dock
		const dockTextAfter = dockLines.join("\n");
		expect(dockTextAfter).not.toContain("AGENT_CARD_FINGERPRINT");

		pc.stopThinking();
		cleanup();
	});

	it("dock height monotonicity across rapid card add/remove cycles", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 24);

		for (let i = 0; i < 5; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.startThinking();
		pc.editor.setText(EDITOR_TAG);
		await settle(200);

		const baseline = partition(tui, chat, 80).dock.length;

		// Rapid add/remove cycles — dock must return to baseline each time
		for (let cycle = 0; cycle < 5; cycle++) {
			pc.showInFlightCall(`c${cycle}`, "shell.exec", `cmd${cycle}`, {});
			tui.requestRender();
			await settle(50);

			const withCard = partition(tui, chat, 80).dock.length;
			expect(withCard).toBeGreaterThanOrEqual(baseline);

			pc.removeInFlightCall(`c${cycle}`);
			tui.requestRender();
			await settle(200);

			const afterRemove = partition(tui, chat, 80).dock.length;
			expect(afterRemove, `dock should return to baseline after cycle ${cycle}`).toBe(baseline);
		}

		pc.stopThinking();
		cleanup();
	});

	it("frame rendered to terminal has no stale card lines after removal", async () => {
		const { tui, pc, chat, writes, cleanup } = setup(80, 24);

		for (let i = 0; i < 5; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.startThinking();
		pc.showInFlightCall("c1", "fs.read", "UNIQUE_CARD_TEXT", { path: "UNIQUE_CARD_TEXT" });

		tui.requestRender(true);
		await settle(200);

		// Verify card appears in rendered output
		const frameWithCard = writes.join("");
		expect(frameWithCard).toContain("UNIQUE_CARD_TEXT");

		writes.length = 0;

		// Remove and re-render
		pc.removeInFlightCall("c1");
		tui.requestRender(true);
		await settle(200);

		// The frame after removal must not contain the card's fingerprint
		const frameAfter = writes.join("");
		expect(frameAfter).not.toContain("UNIQUE_CARD_TEXT");

		pc.stopThinking();
		cleanup();
	});
});

// ---------------------------------------------------------------------------
// 3. Dock reflow monotonicity — no content bleed across dock height changes
// ---------------------------------------------------------------------------
describe("dock reflow monotonicity", { tags: ["unit"] }, () => {
	it("separator line never contains agent card content after card removal", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 24);

		for (let i = 0; i < 5; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.startThinking();
		pc.editor.setText(EDITOR_TAG);

		const CARD_FINGERPRINT = "bleed_detector";
		pc.showInFlightCall("c1", CARD_FINGERPRINT, "key", { text: "test" });
		tui.requestRender(true);
		await settle(100);

		// Verify card is in dock
		const withCard = partition(tui, chat, 80);
		const withCardText = withCard.dock.map(stripAnsi).join("\n");
		expect(withCardText).toContain(CARD_FINGERPRINT);

		// Remove card
		pc.removeInFlightCall("c1");
		tui.requestRender();
		await settle(100);

		// After removal: no dock line should contain the card fingerprint
		const afterRemoval = partition(tui, chat, 80);
		for (const line of afterRemoval.dock) {
			expect(stripAnsi(line)).not.toContain(CARD_FINGERPRINT);
		}

		// Separator lines (rendered by EditorChrome) must be pure separator content
		const separatorLines = afterRemoval.dock.filter((l) => {
			const plain = stripAnsi(l);
			return (
				/^[\u2500\u2501\u2502\u2503\u250C\u2510\u2514\u2518\u251C\u2524\u252C\u2534\u253C\u2574\u2576\u2578\u257A─━]+/.test(
					plain,
				) || /^[-─━═]+/.test(plain)
			);
		});
		for (const sep of separatorLines) {
			expect(stripAnsi(sep)).not.toContain(CARD_FINGERPRINT);
		}

		pc.stopThinking();
		cleanup();
	});

	it("dock height monotonically transitions during card add/remove", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 24);

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.startThinking();
		pc.editor.setText(EDITOR_TAG);
		tui.requestRender(true);
		await settle(100);

		const heights: number[] = [];
		const baseline = partition(tui, chat, 80).dock.length;
		heights.push(baseline);

		// Add three cards one by one
		for (let i = 1; i <= 3; i++) {
			pc.showInFlightCall(`c${i}`, "shell.exec", `cmd${i}`, {});
			tui.requestRender();
			await settle(50);
			heights.push(partition(tui, chat, 80).dock.length);
		}

		// Each add should grow dock (or keep same)
		for (let i = 1; i < heights.length; i++) {
			expect(heights[i]!).toBeGreaterThanOrEqual(heights[i - 1]!);
		}

		// Remove cards one by one — dock should shrink monotonically
		const shrinkHeights: number[] = [heights[heights.length - 1]!];
		for (let i = 3; i >= 1; i--) {
			pc.removeInFlightCall(`c${i}`);
			tui.requestRender();
			await settle(50);
			shrinkHeights.push(partition(tui, chat, 80).dock.length);
		}

		for (let i = 1; i < shrinkHeights.length; i++) {
			expect(shrinkHeights[i]!).toBeLessThanOrEqual(shrinkHeights[i - 1]!);
		}

		// Final height should equal baseline
		expect(shrinkHeights[shrinkHeights.length - 1]).toBe(baseline);

		pc.stopThinking();
		cleanup();
	});

	it("rendered frame has no stale card lines after dock-reflow", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 24);

		for (let i = 0; i < 10; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.startThinking();
		pc.editor.setText(EDITOR_TAG);

		// Add cards with distinct fingerprints
		pc.showInFlightCall("c1", "STALE_CARD_A", "key", { path: "/a" });
		pc.showInFlightCall("c2", "STALE_CARD_B", "key", { command: "ls" });
		tui.requestRender(true);
		await settle(100);

		// Remove one card
		pc.removeInFlightCall("c1");
		tui.requestRender();
		await settle(100);

		// Full frame should not contain removed card's fingerprint
		const afterOne = partition(tui, chat, 80);
		const allText = [...afterOne.scrollRegion, ...afterOne.dock].map(stripAnsi).join("\n");
		expect(allText).not.toContain("STALE_CARD_A");
		expect(allText).toContain("STALE_CARD_B");

		// Remove second card
		pc.removeInFlightCall("c2");
		tui.requestRender();
		await settle(100);

		const afterBoth = partition(tui, chat, 80);
		const finalText = [...afterBoth.scrollRegion, ...afterBoth.dock].map(stripAnsi).join("\n");
		expect(finalText).not.toContain("STALE_CARD_A");
		expect(finalText).not.toContain("STALE_CARD_B");

		pc.stopThinking();
		cleanup();
	});
});

// ---------------------------------------------------------------------------
// 4. Scrollback integrity — lines must not be lost during dock height changes
// ---------------------------------------------------------------------------
describe("scrollback integrity during dock height changes", { tags: ["unit"] }, () => {
	it("archived lines are not lost when dock height changes during streaming", async () => {
		const { tui, pc, chat, writes, cleanup } = setup(80, 16);

		pc.editor.setText(EDITOR_TAG);

		tui.requestRender(true);
		await settle();
		writes.length = 0;

		pc.startThinking();

		// Overflow viewport — lines must be archived even if dock height changes
		for (let i = 0; i < 30; i++) {
			chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
			tui.requestRender();
			await settle(15);
		}

		await settle(300);

		for (let i = 30; i < 50; i++) {
			chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
			tui.requestRender();
			await settle(15);
		}

		const archived = extractArchivePayloads(writes);
		expect(archived.length, "should have archived lines").toBeGreaterThan(0);

		const archivedText = archived.join("\n");
		for (let i = 0; i < 20; i++) {
			expect(archivedText, `${CHAT_TAG}${i} must be in scrollback`).toContain(`${CHAT_TAG}${i}`);
		}

		pc.stopThinking();
		cleanup();
	});

	it("archived lines contain no dock content during dock height changes", async () => {
		const { tui, pc, chat, writes, cleanup } = setup(80, 16);

		pc.editor.setText(EDITOR_TAG);
		pc.setStatus(STATUS_TAG);
		pc.startThinking();
		tui.requestRender(true);
		await settle(200);
		writes.length = 0;

		// Overflow while adding/removing cards — dock height changes repeatedly
		for (let i = 0; i < 20; i++) {
			chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
			if (i === 5) pc.showInFlightCall("c1", "shell.exec", "test", {});
			if (i === 10) pc.removeInFlightCall("c1");
			if (i === 15) pc.showInFlightCall("c2", "fs.read", "file", {});
			tui.requestRender();
			await settle(20);
		}

		pc.removeInFlightCall("c2");
		for (let i = 20; i < 40; i++) {
			chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
			tui.requestRender();
			await settle(15);
		}

		const archived = extractArchivePayloads(writes);
		expect(archived.length).toBeGreaterThan(0);

		const archivedText = archived.join("\n");
		expect(archivedText).toContain(CHAT_TAG);
		expect(archivedText).not.toContain(EDITOR_TAG);
		expect(archivedText).not.toContain(FOOTER_TAG);
		expect(archivedText).not.toContain(STATUS_TAG);

		pc.stopThinking();
		cleanup();
	});

	it("archived lines survive card add/remove during streaming", async () => {
		const { tui, pc, chat, writes, cleanup } = setup(80, 16);

		pc.editor.setText(EDITOR_TAG);
		pc.startThinking();
		tui.requestRender(true);
		await settle(200);
		writes.length = 0;

		for (let i = 0; i < 15; i++) {
			chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
			tui.requestRender();
			await settle(15);
		}

		pc.showInFlightCall("c1", "shell.exec", "test", {});
		tui.requestRender();
		await settle(50);

		for (let i = 15; i < 30; i++) {
			chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
			tui.requestRender();
			await settle(15);
		}

		pc.removeInFlightCall("c1");
		tui.requestRender();
		await settle(50);

		for (let i = 30; i < 45; i++) {
			chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
			tui.requestRender();
			await settle(15);
		}

		const archived = extractArchivePayloads(writes);
		expect(archived.length, "should have archived lines").toBeGreaterThan(0);

		const archivedText = archived.join("\n");
		for (let i = 0; i < 10; i++) {
			expect(archivedText, `${CHAT_TAG}${i} must survive card lifecycle`).toContain(`${CHAT_TAG}${i}`);
		}

		pc.stopThinking();
		cleanup();
	});
});

// ---------------------------------------------------------------------------
// 5. Streaming bodyRows stability — dock height must not oscillate during LLM reply
// ---------------------------------------------------------------------------
describe("spinner mutual exclusion", { tags: ["unit"] }, () => {
	/**
	 * Assert the invariant on every rendered frame: statusText and
	 * inFlightQueue must never both produce visible content.
	 *
	 * The timer races with the intent system — both mutate statusText
	 * and inFlightQueue, both call requestRender(). A settle-based test
	 * either waits too long (timer fires, hides the bug) or too short
	 * (timer hasn't fired, doesn't reproduce it). Hooking onRender
	 * catches violations at the exact frame they occur.
	 */
	function assertExclusivityOnEveryFrame(tui: TUI, pc: DockConsole): { violations: string[]; detach: () => void } {
		const violations: string[] = [];
		const prev = tui.onRender;
		tui.onRender = (frame, w, h) => {
			const statusLines = (pc as any).statusText.render(w) as string[];
			const cardLines = (pc as any).inFlightQueue.render(w) as string[];
			const hasSpinner = statusLines.some((l: string) => l.trim().length > 0);
			const hasCards = cardLines.some((l: string) => l.trim().length > 0);
			if (hasSpinner && hasCards) {
				violations.push(
					`frame has both statusText (${statusLines.length} lines) and ` +
						`inFlightQueue (${cardLines.length} lines) visible`,
				);
			}
			prev?.(frame, w, h);
		};
		return {
			violations,
			detach: () => {
				tui.onRender = prev;
			},
		};
	}

	it("statusText and inFlightQueue are never both visible in any frame", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 24);

		for (let i = 0; i < 5; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.editor.setText(EDITOR_TAG);

		pc.startThinking();
		tui.requestRender(true);
		await settle(200);

		const { violations, detach } = assertExclusivityOnEveryFrame(tui, pc);

		// Cycle: add card, stream, remove card, stream — repeat
		for (let cycle = 0; cycle < 3; cycle++) {
			pc.showInFlightCall(`c${cycle}`, "shell.exec", `cmd${cycle}`, {});
			tui.requestRender();
			await settle(30);

			for (let i = 0; i < 5; i++) {
				chat.addChild(new Text(`stream_${cycle}_${i}`, 0, 0));
				tui.requestRender();
				await settle(15);
			}

			pc.removeInFlightCall(`c${cycle}`);
			tui.requestRender();
			await settle(30);

			for (let i = 0; i < 5; i++) {
				chat.addChild(new Text(`after_${cycle}_${i}`, 0, 0));
				tui.requestRender();
				await settle(15);
			}
		}

		detach();
		pc.stopThinking();
		cleanup();

		expect(
			violations.length,
			`spinner mutual exclusion violated in ${violations.length} frame(s):\n${violations.slice(0, 5).join("\n")}`,
		).toBe(0);
	});

	it("exclusivity holds during rapid card add/remove with no settling", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 24);

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.editor.setText(EDITOR_TAG);

		pc.startThinking();
		tui.requestRender(true);
		await settle(200);

		const { violations, detach } = assertExclusivityOnEveryFrame(tui, pc);

		// Rapid fire — no settle between add/remove
		for (let i = 0; i < 10; i++) {
			pc.showInFlightCall(`r${i}`, "fs.read", `file${i}`, {});
			tui.requestRender();
		}
		await settle(50);

		for (let i = 0; i < 10; i++) {
			pc.removeInFlightCall(`r${i}`);
			tui.requestRender();
		}
		await settle(200);

		detach();
		pc.stopThinking();
		cleanup();

		expect(
			violations.length,
			`spinner mutual exclusion violated in ${violations.length} frame(s):\n${violations.slice(0, 5).join("\n")}`,
		).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 5. Streaming bodyRows stability
// ---------------------------------------------------------------------------
describe("spinner mutual exclusion", { tags: ["unit"] }, () => {
	/**
	 * The invariant: statusText (standalone thinking spinner) and inFlightQueue
	 * (agent card spinners) must never both produce visible output in the same
	 * rendered frame. Assert this at render time, on every frame, so timing
	 * cannot hide the race.
	 */
	function assertSpinnerExclusion(
		pc: DockConsole,
		tui: TUI,
		_chat: Container,
		durationMs: number,
		scenario: () => Promise<void>,
	): Promise<{ frames: number; violations: string[] }> {
		return new Promise((resolve) => {
			const violations: string[] = [];
			let frames = 0;
			const origOnRender = tui.onRender;

			tui.onRender = (frame, w, _h) => {
				frames++;
				const statusLines = (pc as any).statusText.render(w) as string[];
				const cardLines = (pc as any).inFlightQueue.render(w) as string[];
				const statusHasContent = statusLines.some((l: string) => l.trim().length > 0);
				const cardsHaveContent = cardLines.some((l: string) => l.trim().length > 0);
				if (statusHasContent && cardsHaveContent) {
					violations.push(`frame ${frames}: statusText and inFlightQueue both rendered content`);
				}
				origOnRender?.(frame, w, _h);
			};

			scenario().then(async () => {
				await new Promise<void>((r) => setTimeout(r, durationMs));
				tui.onRender = origOnRender;
				resolve({ frames, violations });
			});
		});
	}

	it("statusText and cards are never both visible during tool lifecycle", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 30);

		for (let i = 0; i < 5; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.editor.setText(EDITOR_TAG);
		pc.startThinking();
		tui.requestRender(true);
		await settle(200);

		const { frames, violations } = await assertSpinnerExclusion(pc, tui, chat, 500, async () => {
			// Add card while spinner is running
			pc.showInFlightCall("c1", "shell.exec", "test", { command: "npm test" });
			tui.requestRender();
			await settle(100);

			// Stream some content
			for (let i = 0; i < 5; i++) {
				chat.addChild(new Text(`STREAM_${i}`, 0, 0));
				tui.requestRender();
				await settle(20);
			}

			// Remove card
			pc.removeInFlightCall("c1");
			tui.requestRender();
			await settle(100);

			// Add another card
			pc.showInFlightCall("c2", "fs.read", "file", { path: "/tmp" });
			tui.requestRender();
			await settle(100);

			// Remove it
			pc.removeInFlightCall("c2");
			tui.requestRender();
		});

		expect(frames).toBeGreaterThan(5);
		expect(
			violations,
			`spinner mutual exclusion violated in ${violations.length} of ${frames} frames:\n${violations.join("\n")}`,
		).toHaveLength(0);

		pc.stopThinking();
		cleanup();
	});

	it("rapid card add/remove never produces dual-spinner frames", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 30);

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.editor.setText(EDITOR_TAG);
		pc.startThinking();
		tui.requestRender(true);
		await settle(200);

		const { frames, violations } = await assertSpinnerExclusion(pc, tui, chat, 300, async () => {
			for (let cycle = 0; cycle < 10; cycle++) {
				pc.showInFlightCall(`c${cycle}`, "shell.exec", `cmd${cycle}`, {});
				tui.requestRender();
				// No settle — immediate remove to maximize race window
				pc.removeInFlightCall(`c${cycle}`);
				tui.requestRender();
			}
		});

		expect(frames).toBeGreaterThan(0);
		expect(
			violations,
			`dual-spinner in ${violations.length} of ${frames} frames:\n${violations.join("\n")}`,
		).toHaveLength(0);

		pc.stopThinking();
		cleanup();
	});
});

// ---------------------------------------------------------------------------
// 5. Streaming bodyRows stability — dock height must not oscillate during LLM reply
// ---------------------------------------------------------------------------
describe("streaming bodyRows stability", { tags: ["unit"] }, () => {
	it("bodyRows does not oscillate during simulated LLM streaming", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 30);

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.editor.setText(EDITOR_TAG);
		pc.startThinking();

		tui.requestRender(true);
		await settle(200);

		// Capture dock heights across renders during streaming.
		const dockHeights: number[] = [];
		const origOnRender = tui.onRender;
		tui.onRender = (frame, w, h) => {
			const dockH = partition(tui, chat, w).dock.length;
			dockHeights.push(dockH);
			origOnRender?.(frame, w, h);
		};

		// Simulate 40 LLM streaming chunks adding to scroll region
		for (let i = 0; i < 40; i++) {
			chat.addChild(new Text(`streaming_chunk_${i}`, 0, 0));
			tui.requestRender();
			await settle(20);
		}

		tui.onRender = origOnRender;
		pc.stopThinking();
		cleanup();

		// After the first render establishes the dock height, it must never change
		// during pure streaming (no card add/remove, no editor resize).
		expect(dockHeights.length).toBeGreaterThan(1);
		const stableDockHeight = dockHeights[0]!;
		for (let i = 1; i < dockHeights.length; i++) {
			expect(
				dockHeights[i],
				`dock height oscillated at render ${i}: [${dockHeights.slice(Math.max(0, i - 2), i + 2).join(", ")}]`,
			).toBe(stableDockHeight);
		}
	});

	it("bodyRows does not oscillate during streaming + tool call lifecycle", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 30);

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.editor.setText(EDITOR_TAG);
		pc.startThinking();

		tui.requestRender(true);
		await settle(200);

		// Phase 1: Stream with no cards — capture baseline dock height
		const phase1Heights: number[] = [];
		tui.onRender = () => {
			phase1Heights.push(partition(tui, chat, 80).dock.length);
		};

		for (let i = 0; i < 10; i++) {
			chat.addChild(new Text(`stream_before_card_${i}`, 0, 0));
			tui.requestRender();
			await settle(20);
		}
		await settle(200);

		const baselineDock = phase1Heights[phase1Heights.length - 1]!;

		// Phase 2: Add card — dock grows. Capture new stable height.
		pc.showInFlightCall("c1", "shell.exec", "test", {});
		await settle(200);

		const phase2Heights: number[] = [];
		tui.onRender = () => {
			phase2Heights.push(partition(tui, chat, 80).dock.length);
		};

		for (let i = 0; i < 10; i++) {
			chat.addChild(new Text(`stream_with_card_${i}`, 0, 0));
			tui.requestRender();
			await settle(20);
		}
		await settle(200);

		// During streaming WITH a card, dock height must be stable.
		// Height may equal baseline (card replaces statusText spinner line)
		// or be larger (card adds lines beyond the replaced spinner).
		const withCardDock = phase2Heights[phase2Heights.length - 1]!;
		expect(withCardDock).toBeGreaterThanOrEqual(baselineDock);
		for (const h of phase2Heights) {
			expect(h, "dock height must not oscillate while card is showing").toBe(withCardDock);
		}

		// Phase 3: Remove card — start capturing IMMEDIATELY, no settle.
		// This catches the transient frame where the card is gone but
		// statusText hasn't been restored by the timer yet.
		const phase3Heights: number[] = [];
		tui.onRender = () => {
			phase3Heights.push(partition(tui, chat, 80).dock.length);
		};

		pc.removeInFlightCall("c1");
		// DO NOT settle here — we want to capture the immediate post-removal frame

		for (let i = 0; i < 10; i++) {
			chat.addChild(new Text(`stream_after_card_${i}`, 0, 0));
			tui.requestRender();
			await settle(20);
		}
		await settle(200);

		// After timer stabilization, dock must return to baseline
		const afterCardDock = phase3Heights[phase3Heights.length - 1]!;
		expect(afterCardDock, "dock must return to baseline after card removal").toBe(baselineDock);

		// Dock height must not oscillate during this phase — the key invariant.
		// If removeInFlightCall does not restore statusText synchronously,
		// there's a 1-frame gap where dock is 1 line shorter (card gone,
		// statusText still empty), then the timer fires and restores it.
		// That gap causes bodyRows to jump, which makes scrollback jitter.
		for (const h of phase3Heights) {
			expect(h, "dock height must not oscillate after card removal").toBe(afterCardDock);
		}

		tui.onRender = undefined;
		pc.stopThinking();
		cleanup();
	});

	it("removeInFlightCall restores statusText synchronously (no 1-frame dock gap)", () => {
		const { pc, cleanup } = setup(80, 30);

		pc.startThinking();

		// Manually trigger a timer tick to populate statusText
		// (accessing private thinkingTimer is fragile; instead wait)
		// We use a synchronous check: force statusText to have content by
		// directly calling the public API sequence.

		// Simulate: statusText has spinner content (1 line)
		(pc as any).statusText.setText("spinner placeholder");
		(pc as any).lastThinkingText = "spinner placeholder";
		const beforeCard = (pc as any).statusText.render(80).length;
		expect(beforeCard, "statusText should be 1 line before card").toBe(1);

		// Add card — statusText cleared synchronously (0 lines)
		pc.showInFlightCall("c1", "shell.exec", "test", {});
		const afterAdd = (pc as any).statusText.render(80).length;
		expect(afterAdd, "statusText should be 0 lines after card add").toBe(0);

		// Remove card — statusText must be restored synchronously (1 line)
		// THIS IS THE BUG: removeInFlightCall does NOT restore statusText,
		// leaving a 1-frame gap where dock is 1 line shorter.
		pc.removeInFlightCall("c1");
		const afterRemove = (pc as any).statusText.render(80).length;
		expect(
			afterRemove,
			"statusText must be restored synchronously on last card removal to prevent dock height oscillation",
		).toBe(1);

		pc.stopThinking();
		cleanup();
	});

	it("dock height must not drop transiently after card removal", async () => {
		const { tui, pc, chat, cleanup } = setup(80, 30);

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`${CHAT_TAG}${i}`, 0, 0));
		pc.editor.setText(EDITOR_TAG);
		pc.startThinking();

		tui.requestRender(true);
		await settle(200);

		const baselineDock = partition(tui, chat, 80).dock.length;

		// Add card — dock should stay same (showInFlightCall clears statusText)
		pc.showInFlightCall("c1", "shell.exec", "test", {});

		// Check SYNCHRONOUSLY — no settle, no timer tick
		const immediateAfterAdd = partition(tui, chat, 80).dock.length;
		expect(
			immediateAfterAdd,
			"dock must not change transiently after card add (statusText should be cleared synchronously)",
		).toBe(baselineDock);

		await settle(200);

		// Remove card — this is where the bug lives.
		// If removeInFlightCall does NOT restore statusText synchronously,
		// dock is 1 line shorter until the next timer tick.
		const heightBeforeRemoval = partition(tui, chat, 80).dock.length;
		pc.removeInFlightCall("c1");

		// Check SYNCHRONOUSLY — no settle, no timer tick
		const immediateAfterRemove = partition(tui, chat, 80).dock.length;
		expect(
			immediateAfterRemove,
			"dock must not drop transiently after card removal — " +
				`was ${heightBeforeRemoval} before, got ${immediateAfterRemove} immediately after. ` +
				"removeInFlightCall must restore statusText synchronously when last card is removed",
		).toBe(heightBeforeRemoval);

		pc.stopThinking();
		cleanup();
	});

	it("statusText line count is stable between timer ticks during streaming", async () => {
		const { pc, cleanup } = setup(80, 30);

		pc.startThinking();
		await settle(200);

		// statusText should be 1 line (spinner) and stay 1 line
		const lineCountBefore = (pc as any).statusText.render(80).length;
		expect(lineCountBefore, "statusText should be 1 line during thinking").toBe(1);

		// Wait several timer ticks
		await settle(500);

		const lineCountAfter = (pc as any).statusText.render(80).length;
		expect(lineCountAfter, "statusText line count must not change between ticks").toBe(lineCountBefore);

		pc.stopThinking();
		cleanup();
	});
});

// ---------------------------------------------------------------------------
// 5. Dock stability
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

	it("statusText is cleared immediately when first card is added (no tick delay)", async () => {
		const { pc, cleanup } = setup();

		pc.startThinking();
		await settle(200);

		// Spinner is running -- statusText has braille content
		const statusBefore = (pc as any).statusText.render(80) as string[];
		const hasBraille = statusBefore.some((l: string) => /[\u2800-\u28FF]/.test(l));
		expect(hasBraille, "statusText should have braille before cards").toBe(true);

		// Add a card -- statusText must be cleared IMMEDIATELY, not on next tick
		pc.showInFlightCall("c1", "shell.exec", "test", {});

		// Check SYNCHRONOUSLY -- no settle, no tick
		const statusAfter = (pc as any).statusText.render(80) as string[];
		const statusBrailleAfter = statusAfter.filter((l: string) => /[\u2800-\u28FF]/.test(l));
		expect(
			statusBrailleAfter.length,
			"statusText must be cleared immediately on first card add, not wait for next tick",
		).toBe(0);

		pc.removeInFlightCall("c1");
		pc.stopThinking();
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
