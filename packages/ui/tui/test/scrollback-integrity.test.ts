/**
 * Scrollback integrity — pre-boot TTY lines and archived chat must survive
 * Alef boot, chat growth, and terminal resize. ESC[3J (erase saved lines)
 * is forbidden after the TUI has taken over the viewport.
 */
import { describe, expect, it } from "vitest";
import { Text } from "../src/components/text.js";
import { Container, TUI } from "../src/tui.js";
import { DynamicText } from "../src/views/index.js";
import { VirtualTerminal } from "./virtual-terminal.js";

async function settle(ms = 40): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
	await new Promise<void>((r) => process.nextTick(r));
}

function bufferContains(terminal: VirtualTerminal, needle: string): boolean {
	return terminal.getScrollBuffer().some((line) => line.includes(needle));
}

describe("scrollback integrity", { tags: ["unit"] }, () => {
	it("preserves pre-boot TTY lines through dock TUI boot and resize", async () => {
		const terminal = new VirtualTerminal(50, 8);
		// Seed more lines than the viewport so early shell output is in scrollback
		// (not merely overwritten when Alef paints the visible rows).
		for (let i = 0; i < 20; i++) {
			terminal.write(`PREBOOT-${i}\r\n`);
		}
		await terminal.flush();
		expect(bufferContains(terminal, "PREBOOT-0")).toBe(true);
		expect(terminal.getScrollBuffer().length).toBeGreaterThan(terminal.rows);

		const writes: string[] = [];
		const originalWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};

		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => tui.requestRender(),
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		chat.addChild(new Text("chat-start", 0, 0));
		const dock = new DynamicText(() => "EDITOR");
		tui.addChild(dock);
		tui.setDock(dock);

		tui.requestRender(true);
		await settle();

		expect(bufferContains(terminal, "PREBOOT-0"), "boot must not erase pre-TTY scrollback").toBe(true);
		expect(
			writes.join("").includes("\x1b[3J"),
			"boot/first paints must not emit ESC[3J (erase saved lines)",
		).toBe(false);

		writes.length = 0;
		terminal.resize(50, 12);
		await settle();

		expect(
			writes.join("").includes("\x1b[3J"),
			"resize must not emit ESC[3J — that truncates shell + Alef scrollback",
		).toBe(false);
		expect(bufferContains(terminal, "PREBOOT-0"), "pre-boot lines must survive resize").toBe(true);
		expect(bufferContains(terminal, "PREBOOT-5")).toBe(true);

		tui.stop();
	});

	it("keeps archived chat in scrollback across dock growth and later resize", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const writes: string[] = [];
		const originalWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};

		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => tui.requestRender(),
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 4; i++) chat.addChild(new Text(`archive-me-${i}`, 0, 0));
		const dock = new DynamicText(() => "EDITOR");
		tui.addChild(dock);
		tui.setDock(dock);

		tui.requestRender(true);
		await settle();
		writes.length = 0;

		// Overflow the body so early chat is archived into terminal scrollback.
		for (let i = 4; i < 24; i++) {
			chat.addChild(new Text(`archive-me-${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}

		expect(writes.some((w) => w.includes("\x1b[3J"))).toBe(false);
		expect(bufferContains(terminal, "archive-me-0")).toBe(true);
		expect(bufferContains(terminal, "archive-me-1")).toBe(true);

		writes.length = 0;
		// Width change historically took paintFrame(clear=true) with ESC[3J.
		terminal.resize(60, 8);
		await settle();

		expect(
			writes.join("").includes("\x1b[3J"),
			"width resize must not wipe archived chat via ESC[3J",
		).toBe(false);
		expect(
			bufferContains(terminal, "archive-me-0"),
			`archived early chat must remain after resize; buffer=\n${terminal
				.getScrollBuffer()
				.filter(Boolean)
				.slice(0, 30)
				.join("\n")}`,
		).toBe(true);

		writes.length = 0;
		terminal.resize(60, 14);
		await settle();
		expect(writes.join("").includes("\x1b[3J")).toBe(false);
		expect(bufferContains(terminal, "archive-me-0")).toBe(true);

		tui.stop();
	});
});
