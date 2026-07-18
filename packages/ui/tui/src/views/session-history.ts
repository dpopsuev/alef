/**
 * Session history load — projects prior turns into the chat view in yielded chunks
 * so the TUI stays interactive (scroll/input) while resume history paints.
 */

import type { SessionStore } from "@dpopsuev/alef-session/storage";
import {
	type DisplayBlock,
	loadPlanPreview,
	projectTranscriptSlice,
} from "@dpopsuev/alef-session/context";
import type { Component } from "../component.js";
import type { ChatLog } from "./chat-log.js";

const DEFAULT_MAX_TURNS = 5;
const DEFAULT_CHUNK_SIZE = 4;

/**
 *
 */
export interface SessionHistoryOptions {
	/** Maximum number of prior dialog turns to prefer. Default: 5. */
	maxTurns?: number;
	/** Project cwd for multi-plan shelf preview. */
	cwd?: string;
	/** Display blocks painted per event-loop slice. Default: 4. */
	chunkSize?: number;
	/** Cancel an in-flight load (e.g. discussion switch). */
	signal?: AbortSignal;
	/** Invoked after each painted chunk so the host can requestRender. */
	onChunk?: () => void;
}

/** Yield so input/scroll/render can run between history paint chunks. */
export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Map projected display blocks onto ChatLog write APIs.
 * Shared by resume history and session-picker preview (via renderDisplayBlocksToLines).
 */
export function appendDisplayBlocks(writer: ChatLog, blocks: readonly DisplayBlock[]): void {
	for (const block of blocks) {
		switch (block.kind) {
			case "plan": {
				const steps = block.lines.length > 0 ? `\n  ${block.lines.join("\n  ")}` : "";
				writer.addNotice(`◆ plan [${block.phase}] ${block.desired}${steps}`);
				break;
			}
			case "user":
				writer.addUserMessage(block.text);
				break;
			case "assistant":
				writer.addAgentReply(block.text);
				break;
			case "tool":
				writer.addCompletedToolBlock(block.name, block.summary ?? "", {}, 0, true, null, null);
				break;
			case "state":
				writer.addNotice(`▨ ${block.label}: ${block.text}`);
				break;
		}
	}
}

/**
 * Prepend session history into the chat view using the shared transcript projector.
 * Fetches off-thread from the UI start path; paints in small yielded chunks.
 */
export async function prependSessionHistory(
	store: SessionStore,
	writer: ChatLog,
	opts: SessionHistoryOptions = {},
): Promise<void> {
	const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
	const chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
	const signal = opts.signal;
	const onChunk = opts.onChunk;

	const loading = paintAtFront(writer, () => {
		writer.addNotice("Loading session…");
	});
	onChunk?.();
	await yieldToEventLoop();
	if (signal?.aborted) {
		removeComponents(writer, loading);
		onChunk?.();
		return;
	}

	const events = await store.events();
	if (signal?.aborted) {
		removeComponents(writer, loading);
		onChunk?.();
		return;
	}

	const plan = await loadPlanPreview(opts.cwd);
	if (signal?.aborted) {
		removeComponents(writer, loading);
		onChunk?.();
		return;
	}

	const kept = projectTranscriptSlice(
		events.map((event) => ({
			bus: event.bus,
			type: event.type,
			payload: event.payload,
		})),
		maxTurns,
		plan ? { plan } : undefined,
	);

	removeComponents(writer, loading);

	if (kept.length === 0) {
		onChunk?.();
		return;
	}

	const turnCount = kept.filter((block) => block.kind === "user").length;
	let insertAt = 0;

	insertAt += paintAt(writer, insertAt, () => {
		writer.addNotice(`Resumed — ${turnCount} prior turn${turnCount === 1 ? "" : "s"} loaded`);
	});
	onChunk?.();
	await yieldToEventLoop();

	for (let offset = 0; offset < kept.length; offset += chunkSize) {
		if (signal?.aborted) return;
		const slice = kept.slice(offset, offset + chunkSize);
		insertAt += paintAt(writer, insertAt, () => {
			appendDisplayBlocks(writer, slice);
		});
		onChunk?.();
		await yieldToEventLoop();
	}
}

/** Append via writer APIs, then move the new children to `index` (preserving order). */
function paintAt(writer: ChatLog, index: number, paint: () => void): number {
	const start = writer.container.children.length;
	paint();
	const created = writer.container.children.splice(start);
	for (let i = 0; i < created.length; i++) {
		writer.container.insertAt(index + i, created[i]!);
	}
	return created.length;
}

/** Paint then move new children to index 0 (newest-first insert of a batch). */
function paintAtFront(writer: ChatLog, paint: () => void): Component[] {
	const start = writer.container.children.length;
	paint();
	const created = writer.container.children.splice(start);
	for (let i = created.length - 1; i >= 0; i--) {
		writer.container.insertAt(0, created[i]!);
	}
	return created;
}

/** Drop components previously painted for the loading marker. */
function removeComponents(writer: ChatLog, components: readonly Component[]): void {
	for (const component of components) {
		writer.container.removeChild(component);
	}
}
