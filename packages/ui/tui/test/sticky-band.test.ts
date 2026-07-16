/**
 * Sticky bottom band — live streaming/input/footer must never enter scrollback
 * when chat grows or live widgets tick.
 */

import { describe, expect, it } from "vitest";
import { Text } from "../src/components/text.js";
import { Container, TUI } from "../src/tui.js";
import { DynamicText } from "../src/views/index.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function makeEnv(cols = 40, rows = 8) {
	const terminal = new VirtualTerminal(cols, rows);
	const tui = new TUI(terminal);
	terminal.start(
		() => {},
		() => {},
	);
	tui.start();
	return { terminal, tui };
}

async function settle(ms = 30): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
}

describe("sticky bottom band", { tags: ["unit"] }, () => {
	it("keeps live sticky content in the viewport when chat overflows", async () => {
		const { tui } = makeEnv(40, 6);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 20; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		let tick = 0;
		const live = new DynamicText(() => `LIVE ${tick}`);
		const editor = new Text("EDITOR", 0, 0);
		tui.addChild(live);
		tui.setStickyFrom(live);
		tui.addChild(editor);

		tui.requestRender(true);
		await settle();

		const frame = tui.renderMeta.totalLines;
		expect(frame).toBe(6);
		expect(tui.renderMeta.renderPath).not.toBe("scrollback");

		const onRenderFrames: string[] = [];
		tui.onRender = (f) => {
			onRenderFrames.push(f);
		};

		tick = 1;
		tui.requestRender();
		await settle();

		expect(tui.renderMeta.renderPath).toBe("diff");
		expect(tui.renderMeta.prevViewportTop).toBe(0);
		expect(tui.renderMeta.renderPath).not.toBe("scrollback");
		const last = onRenderFrames.at(-1) ?? "";
		expect(last).toContain("LIVE 1");
		expect(last).toContain("EDITOR");
		// Chat head is outside the body window — not in the viewport frame
		expect(last).not.toContain("chat-0");
		tui.stop();
	});

	it("live sticky ticks never take the scrollback render path", async () => {
		const { tui } = makeEnv(40, 5);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 12; i++) chat.addChild(new Text(`line ${i}`, 0, 0));

		let tick = 0;
		const status = new DynamicText(() => `status:${tick}`);
		const tasks = new DynamicText(() => `task-1 ${tick}s`);
		tui.addChild(status);
		tui.setStickyFrom(status);
		tui.addChild(tasks);

		tui.requestRender(true);
		await settle();

		const paths: string[] = [];
		tui.onRender = () => {
			paths.push(tui.renderMeta.renderPath);
		};

		for (let i = 0; i < 8; i++) {
			tick = i + 1;
			tui.requestRender();
			await settle(20);
		}

		expect(paths.every((p) => p !== "scrollback")).toBe(true);
		expect(paths.some((p) => p === "diff" || p === "no-change")).toBe(true);
		tui.stop();
	});

	it("growing chat above sticky does not mark sticky updates as scrollback", async () => {
		const { tui } = makeEnv(40, 6);
		const chat = new Container();
		tui.addChild(chat);
		chat.addChild(new Text("seed", 0, 0));

		let tick = 0;
		const sticky = new DynamicText(() => `sticky-${tick}`);
		tui.addChild(sticky);
		tui.setStickyFrom(sticky);

		tui.requestRender(true);
		await settle();

		const paths: string[] = [];
		tui.onRender = () => {
			paths.push(tui.renderMeta.renderPath);
		};

		for (let i = 0; i < 15; i++) {
			chat.addChild(new Text(`msg-${i}`, 0, 0));
			tick = i;
			tui.requestRender();
			await settle(20);
		}

		expect(paths.filter((p) => p === "scrollback")).toHaveLength(0);
		expect(tui.renderMeta.prevViewportTop).toBe(0);
		tui.stop();
	});

	it("caps an oversized sticky band so the editor stays in the frame", async () => {
		const { tui } = makeEnv(40, 5);
		const chat = new Container();
		tui.addChild(chat);
		chat.addChild(new Text("hello", 0, 0));

		const stickyRoot = new Container();
		tui.addChild(stickyRoot);
		tui.setStickyFrom(stickyRoot);
		for (let i = 0; i < 10; i++) stickyRoot.addChild(new Text(`widget-${i}`, 0, 0));
		stickyRoot.addChild(new Text("EDITOR", 0, 0));

		const frames: string[] = [];
		tui.onRender = (f) => {
			frames.push(f);
		};
		tui.requestRender(true);
		await settle();

		const last = frames.at(-1) ?? "";
		expect(last).toContain("EDITOR");
		// Top of oversized sticky was clipped
		expect(last).not.toContain("widget-0");
		expect(tui.renderMeta.totalLines).toBe(5);
		tui.stop();
	});
});
