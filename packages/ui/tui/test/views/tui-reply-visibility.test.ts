import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text } from "../../src/components/text.js";
import { Container, TUI } from "../../src/tui.js";
import { ReplyBlock } from "../../src/views/index.js";
import { VirtualTerminal } from "../virtual-terminal.js";

const C = { ansi16: 37 };
function getTheme() {
	return {
		userFg: C,
		userBg: C,
		agentFg: C,
		agentBg: C,
		primaryFg: C,
		secondaryFg: C,
		mutedFg: C,
		accentFg: C,
		brightFg: C,
		okFg: C,
		warnFg: C,
		errFg: C,
	};
}

const COLS = 120;
const ROWS = 40;

function makeEnv() {
	const terminal = new VirtualTerminal(COLS, ROWS);
	const tui = new TUI(terminal);
	const chat = new Container();
	tui.addChild(chat);
	terminal.start(
		() => {},
		() => {},
	);
	return { terminal, tui, chat };
}

function screenText(terminal: VirtualTerminal): string {
	return terminal
		.getScrollBuffer()
		.map((l) => stripVTControlCharacters(l).trimEnd())
		.filter(Boolean)
		.join("\n");
}

async function settle(): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, 30));
}

describe("reply reaches screen via ReplyBlock", { tags: ["unit"] }, () => {
	let env: ReturnType<typeof makeEnv>;

	beforeEach(() => {
		env = makeEnv();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		env.terminal.stop();
		vi.useRealTimers();
	});

	it("reply text appears after tool calls then seal", async () => {
		const { terminal, tui, chat } = env;
		const zone = new ReplyBlock(chat, () => tui.requestRender(), getTheme());

		zone.reset();
		zone.reset();

		const reply = "# Overview\n\nAlef is an EDA-based AI coding agent.";
		for (const ch of reply) zone.receiveText(ch);

		zone.reset();
		tui.requestRender(true);
		await settle();

		expect(screenText(terminal)).toContain("Alef is an EDA-based AI coding agent");
	});

	it("large reply end is visible in scroll buffer after many tool lines", async () => {
		const { terminal, tui, chat } = env;
		const zone = new ReplyBlock(chat, () => tui.requestRender(), getTheme());

		for (let i = 0; i < 10; i++) {
			zone.reset();
			chat.addChild(new Text(`  ✓ fs.read  file${i}.ts  12ms`, 1, 0));
		}

		const sentinel = "SENTINEL_END_OF_REPLY";
		const body = Array.from({ length: 20 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1}.`).join("\n\n");
		for (const ch of `${body}\n\n${sentinel}`) zone.receiveText(ch);

		zone.reset();
		tui.requestRender(true);
		await settle();

		expect(screenText(terminal)).toContain(sentinel);
	});

	it("each chunk reaches the markdown node immediately", () => {
		const { tui, chat } = env;
		const zone = new ReplyBlock(chat, () => tui.requestRender(), getTheme());

		zone.receiveText("Hello world");

		expect(zone.markdownNode?.getText()).toBe("Hello world");
	});

	it("requestRender(true) after seal writes content to screen", async () => {
		const { terminal, tui, chat } = env;
		const zone = new ReplyBlock(chat, () => tui.requestRender(), getTheme());

		zone.receiveText("The quick brown fox");
		zone.reset();
		tui.requestRender(true);
		await settle();

		expect(screenText(terminal)).toContain("quick brown fox");
	});
});

describe("toolSlot.receiveTextChunk wiring", { tags: ["unit"] }, () => {
	let env: ReturnType<typeof makeEnv>;

	beforeEach(() => {
		env = makeEnv();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		env.terminal.stop();
		vi.useRealTimers();
	});

	it("receiveTextChunk puts reply in scroll buffer", async () => {
		const { terminal, tui, chat } = env;
		const zone = new ReplyBlock(chat, () => tui.requestRender(), getTheme());

		const reply = "Alef is an EDA-based coding agent.";
		for (const ch of reply) zone.receiveText(ch);

		zone.reset();
		tui.requestRender(true);
		await settle();

		expect(screenText(terminal)).toContain("EDA-based coding agent");
	});

	it("chunks before wiring are absent from screen", async () => {
		const { terminal, tui, chat } = env;
		const slot: { fn: ((chunk: string) => void) | undefined } = { fn: undefined };

		slot.fn?.("SHOULD_NOT_APPEAR");

		const zone = new ReplyBlock(chat, () => tui.requestRender(), getTheme());
		slot.fn = (chunk) => zone.receiveText(chunk);

		for (const ch of "EDA tool-based agent reply.") slot.fn(ch);

		zone.reset();
		tui.requestRender(true);
		await settle();

		const screen = screenText(terminal);
		expect(screen).not.toContain("SHOULD_NOT_APPEAR");
		expect(screen).toContain("EDA tool-based agent reply");
	});
});

describe("empty segment pruned on seal", { tags: ["unit"] }, () => {
	let env: ReturnType<typeof makeEnv>;

	beforeEach(() => {
		env = makeEnv();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		env.terminal.stop();
		vi.useRealTimers();
	});

	it("seal with no text removes the segment from chat", async () => {
		const { tui, chat } = env;
		const zone = new ReplyBlock(chat, () => tui.requestRender(), getTheme());
		const childsBefore = chat.children.length;

		zone.reset();

		tui.requestRender(true);
		await settle();

		expect(chat.children.length).toBe(childsBefore);
	});

	it("reply is visible when seal happens before stopThinking", async () => {
		const { terminal, tui, chat } = env;
		const zone = new ReplyBlock(chat, () => tui.requestRender(), getTheme());

		zone.receiveText("The full reply text.");
		zone.reset();
		tui.requestRender(true);
		await settle();

		expect(screenText(terminal)).toContain("The full reply text.");
	});
});
