/**
 * Frame integrity tests -- verify the TUI never produces frames that
 * overflow the terminal viewport or have lines wider than the terminal.
 */

import { describe, expect, it } from "vitest";
import { Text } from "../src/components/text.js";
import type { RenderMeta } from "../src/tui.js";
import { Container, TUI } from "../src/tui.js";
import { visibleWidth } from "../src/utils.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function makeEnv(cols = 80, rows = 24) {
	const terminal = new VirtualTerminal(cols, rows);
	const tui = new TUI(terminal);
	const frames: string[][] = [];
	tui.onRender = (frame) => {
		frames.push(frame.split("\n"));
	};
	terminal.start(() => {}, () => {});
	tui.start();
	return { terminal, tui, frames };
}

async function settle(): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, 20));
}

describe("frame integrity", { tags: ["unit"] }, () => {
	describe("sticky mode", () => {
		it("frame height equals terminal rows", async () => {
			const { tui, frames } = makeEnv(80, 24);
			const chat = new Container();
			const footer = new Text("footer", 0, 0);
			tui.addChild(chat);
			tui.addChild(footer);
			tui.setStickyFrom(footer);

			for (let i = 0; i < 30; i++) {
				chat.addChild(new Text(`line ${i}`, 0, 0));
			}
			tui.requestRender(true);
			await settle();

			expect(frames.length).toBeGreaterThan(0);
			const lastFrame = frames[frames.length - 1]!;
			expect(lastFrame.length).toBe(24);
		});

		it("no line exceeds terminal width", async () => {
			const { tui, frames } = makeEnv(40, 10);
			const chat = new Container();
			const footer = new Text("footer", 0, 0);
			tui.addChild(chat);
			tui.addChild(footer);
			tui.setStickyFrom(footer);

			chat.addChild(new Text("x".repeat(200), 0, 0));
			tui.requestRender(true);
			await settle();

			expect(frames.length).toBeGreaterThan(0);
			const lastFrame = frames[frames.length - 1]!;
			for (let i = 0; i < lastFrame.length; i++) {
				const w = visibleWidth(lastFrame[i]!);
				expect(w, `line ${i} width ${w} exceeds 40`).toBeLessThanOrEqual(40);
			}
		});

		it("frame size stays constant with growing content", async () => {
			const { tui, frames } = makeEnv(80, 10);
			const chat = new Container();
			const footer = new Text("footer", 0, 0);
			tui.addChild(chat);
			tui.addChild(footer);
			tui.setStickyFrom(footer);

			for (let i = 0; i < 20; i++) {
				chat.addChild(new Text(`msg ${i}`, 0, 0));
			}
			tui.requestRender(true);
			await settle();

			expect(frames.length).toBeGreaterThan(0);
			const lastFrame = frames[frames.length - 1]!;
			expect(lastFrame.length).toBe(10);
		});
	});

	describe("non-sticky mode", () => {
		it("no line exceeds terminal width", async () => {
			const { tui, frames } = makeEnv(40, 10);
			tui.addChild(new Text("a".repeat(200), 0, 0));
			tui.requestRender(true);
			await settle();

			expect(frames.length).toBeGreaterThan(0);
			const lastFrame = frames[frames.length - 1]!;
			for (const line of lastFrame) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(40);
			}
		});
	});

	describe("incremental updates", () => {
		it("maintains integrity after content change", async () => {
			const { tui, frames } = makeEnv(60, 12);
			const chat = new Container();
			const footer = new Text("FOOTER", 0, 0);
			tui.addChild(chat);
			tui.addChild(footer);
			tui.setStickyFrom(footer);

			const dynamic = new Text("short", 0, 0);
			chat.addChild(dynamic);
			tui.requestRender(true);
			await settle();

			dynamic.setText("x".repeat(200));
			tui.requestRender(true);
			await settle();

			expect(frames.length).toBeGreaterThanOrEqual(2);
			const lastFrame = frames[frames.length - 1]!;
			expect(lastFrame.length).toBe(12);
			for (const line of lastFrame) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(60);
			}
			// Frame size invariant holds after content change
			expect(lastFrame.length).toBe(12);
		});

		it("handles rapid content growth", async () => {
			const { tui, frames } = makeEnv(80, 15);
			const chat = new Container();
			const footer = new Text("---", 0, 0);
			tui.addChild(chat);
			tui.addChild(footer);
			tui.setStickyFrom(footer);

			for (let i = 0; i < 30; i++) {
				chat.addChild(new Text(`chunk ${i}`, 0, 0));
				tui.requestRender(true);
			}
			await settle();

			expect(frames.length).toBeGreaterThan(0);
			for (let fi = 0; fi < frames.length; fi++) {
				expect(frames[fi]!.length, `frame ${fi}`).toBe(15);
			}
		});
	});
});
