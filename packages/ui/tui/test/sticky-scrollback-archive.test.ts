/**
 * Sticky-band growth must archive chat into terminal scrollback, not discard it.
 */

import { describe, expect, it } from "vitest";
import { Text } from "../src/components/text.js";
import { Container, TUI } from "../src/tui.js";
import { DynamicText } from "../src/views/index.js";
import { VirtualTerminal } from "./virtual-terminal.js";

async function settle(ms = 30): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
}

describe("sticky scrollback archive", { tags: ["unit"] }, () => {
	it("archives overflow chat lines into the terminal scroll region when chat grows", async () => {
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
			() => {},
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 4; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		const sticky = new DynamicText(() => "EDITOR");
		tui.addChild(sticky);
		tui.setStickyFrom(sticky);

		tui.requestRender(true);
		await settle();
		writes.length = 0;

		for (let i = 4; i < 20; i++) {
			chat.addChild(new Text(`chat-${i}`, 0, 0));
			tui.requestRender();
			await settle(15);
		}

		const archiveWrites = writes.filter((w) => /\\x1b\[1;\d+r/.test(w) || /\x1b\[1;\d+r/.test(w));
		expect(
			archiveWrites.length,
			"growing chat under sticky must push lines via scroll-region archive",
		).toBeGreaterThan(0);
		expect(writes.some((w) => w.includes("\x1b[3J"))).toBe(false);

		const joined = writes.join("");
		expect(joined).toContain("chat-0");
		tui.stop();
	});
});
