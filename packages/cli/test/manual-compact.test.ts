/**
 * Manual :compact — must use an injected LLM summarizer (never a stub),
 * force a cut even under the keep budget, and persist context.compaction.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestCompaction } from "@dpopsuev/alef-session/compaction";
import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import { Container } from "@dpopsuev/alef-tui";
import { ChatLog } from "@dpopsuev/alef-tui/views";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compact } from "../src/client/commands/lifecycle-cmds.js";
import { runManualCompact } from "../src/client/commands/manual-compact.js";
import type { TuiHandlerContext } from "../src/client/commands/types.js";
import { getTheme } from "../src/client/theme.js";

const tempDirs: string[] = [];

function tmpCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "alef-manual-compact-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function seedHistory(
	store: JsonlSessionStore,
	messages: Array<{ role: string; content: string }>,
): Promise<void> {
	await store.append({
		bus: "command",
		type: "llm.response",
		correlationId: "seed",
		payload: {
			text: messages.at(-1)?.content ?? "",
			conversationHistory: messages,
		},
		timestamp: Date.now(),
	});
}

function makeCtx(overrides: Partial<TuiHandlerContext> = {}): TuiHandlerContext {
	const t = getTheme();
	const chat = new Container();
	return {
		t,
		writer: new ChatLog(chat, t),
		tui: { stop: vi.fn(), requestRender: vi.fn() },
		session: {
			state: { id: "test", modelId: "m", contextWindow: 200_000 },
			getModel: () => "m",
			setModel: vi.fn(),
			getThinking: () => "off",
			setThinking: vi.fn(),
			setTurnController: vi.fn(),
			dispose: vi.fn(),
			subscribe: () => () => {},
		},
		dispatch: vi.fn(),
		abortCurrentTurn: undefined,
		setAbortCurrentTurn: vi.fn(),
		...overrides,
	};
}

function noticeText(ctx: TuiHandlerContext): string {
	return ctx.writer.container.children
		.flatMap((c) => c.render(120))
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("runManualCompact", { tags: ["unit"] }, () => {
	it("calls the injected summarizer and persists context.compaction under keep budget", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await seedHistory(store, [
			{ role: "user", content: "short a" },
			{ role: "assistant", content: "short b" },
			{ role: "user", content: "short c" },
			{ role: "assistant", content: "short d" },
		]);

		const seen: Array<{ count: number; instructions?: string }> = [];
		const { result, notice } = await runManualCompact({
			store,
			keepRecentTokens: 20_000,
			instructions: "keep file paths",
			summarize: (msgs, opts) => {
				seen.push({ count: msgs.length, instructions: opts?.instructions });
				return "## Goal\nReal LLM summary — not a stub";
			},
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]!.instructions).toBe("keep file paths");
		expect(seen[0]!.count).toBeGreaterThan(0);
		expect(result.compactedTurns).toBeGreaterThan(0);
		expect(result.summary).toBe("## Goal\nReal LLM summary — not a stub");
		expect(result.summary).not.toMatch(/Manual compaction/);
		expect(notice).toMatch(/compacted/);

		const compaction = latestCompaction(await store.events());
		expect(compaction).toBeDefined();
		expect(compaction!.payload.summary).toBe("## Goal\nReal LLM summary — not a stub");
	});

	it("forces a cut under a huge keepRecentTokens budget (manual compact must not no-op)", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await seedHistory(store, [
			{ role: "user", content: "one" },
			{ role: "assistant", content: "two" },
			{ role: "user", content: "three" },
		]);

		let summarized = 0;
		const { result } = await runManualCompact({
			store,
			keepRecentTokens: 1_000_000,
			summarize: (msgs) => {
				summarized = msgs.length;
				return "## Goal\nForced under budget";
			},
		});

		expect(summarized).toBeGreaterThan(0);
		expect(result.compactedTurns).toBeGreaterThan(0);
		expect(result.summary).toBe("## Goal\nForced under budget");
		expect(result.summary).not.toMatch(/Manual compaction|earlier messages/);
	});
});

describe(":compact command", { tags: ["unit"] }, () => {
	it("refuses to run without an LLM summarizer", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await seedHistory(store, [
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
		]);
		const ctx = makeCtx({ store });
		compact.run(ctx, []);
		await vi.waitFor(() => expect(noticeText(ctx)).toMatch(/no LLM summarizer/));
	});

	it("uses session.summarizeForCompaction and writes durable summary", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await seedHistory(store, [
			{ role: "user", content: "alpha" },
			{ role: "assistant", content: "beta" },
			{ role: "user", content: "gamma" },
			{ role: "assistant", content: "delta" },
		]);

		const summarize = vi.fn(async (_msgs: readonly unknown[], opts?: { instructions?: string }) => {
			expect(opts?.instructions).toBe("focus on errors");
			return "## Goal\nFrom session summarizer";
		});

		const ctx = makeCtx({
			store,
			session: {
				...makeCtx().session,
				summarizeForCompaction: summarize,
			},
		});

		compact.run(ctx, ["focus", "on", "errors"]);
		await vi.waitFor(() => expect(noticeText(ctx)).toMatch(/compacted/));

		expect(summarize).toHaveBeenCalledOnce();
		const compaction = latestCompaction(await store.events());
		expect(compaction!.payload.summary).toBe("## Goal\nFrom session summarizer");
		expect(String(compaction!.payload.summary)).not.toMatch(/Manual compaction/);
	});

	it("dispatches compacting and compacted UI signals for :compact", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await seedHistory(store, [
			{ role: "user", content: "alpha" },
			{ role: "assistant", content: "beta" },
			{ role: "user", content: "gamma" },
			{ role: "assistant", content: "delta" },
		]);

		const dispatch = vi.fn();
		const ctx = makeCtx({
			store,
			dispatch,
			session: {
				...makeCtx().session,
				summarizeForCompaction: vi.fn(async () => "## Goal\nSignal test summary"),
			},
		});

		compact.run(ctx, []);
		await vi.waitFor(() => expect(noticeText(ctx)).toMatch(/compacted/));

		expect(dispatch).toHaveBeenNthCalledWith(1, {
			type: "adapter-signal",
			signalType: "context.compacting",
			payload: { active: true },
		});
		expect(dispatch).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				type: "adapter-signal",
				signalType: "context.compacted",
				payload: expect.objectContaining({
					compactedTurns: expect.any(Number),
					estimatedBefore: expect.any(Number),
					estimatedAfter: expect.any(Number),
				}),
			}),
		);
		expect(dispatch).toHaveBeenNthCalledWith(3, {
			type: "adapter-signal",
			signalType: "context.compacting",
			payload: { active: false },
		});
	});

	it("dispatches context.compacting active=false when :compact fails", async () => {
		const cwd = tmpCwd();
		const store = await JsonlSessionStore.create(cwd);
		await seedHistory(store, [
			{ role: "user", content: "alpha" },
			{ role: "assistant", content: "beta" },
		]);

		const dispatch = vi.fn();
		const ctx = makeCtx({
			store,
			dispatch,
			session: {
				...makeCtx().session,
				summarizeForCompaction: vi.fn(async () => {
					throw new Error("summary failed");
				}),
			},
		});

		compact.run(ctx, []);
		await vi.waitFor(() => expect(noticeText(ctx)).toMatch(/summary failed/));

		expect(dispatch).toHaveBeenCalledWith({
			type: "adapter-signal",
			signalType: "context.compacting",
			payload: { active: true },
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "adapter-signal",
			signalType: "context.compacting",
			payload: { active: false },
		});
		expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ signalType: "context.compacted" }));
	});
});
