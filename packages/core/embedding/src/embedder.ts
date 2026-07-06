import type { Client } from "@libsql/client";
import { RecallStore } from "./recall.js";

/**
 *
 */
export interface Embedder {
	embed(text: string): Promise<number[]>;
}

let _embedder: Embedder | undefined;

/**
 *
 */
export function setEmbedder(embedder: Embedder): void {
	_embedder = embedder;
}

/**
 *
 */
export function getEmbedder(): Embedder | undefined {
	return _embedder;
}

const EMBEDDABLE_PREFIXES = ["fs.", "shell.", "code.", "llm.", "web.", "agent."];

/**
 *
 */
function shouldEmbed(bus: string, type: string): boolean {
	if (bus !== "command" && bus !== "event") return false;
	return EMBEDDABLE_PREFIXES.some((p) => type.startsWith(p));
}

/**
 *
 */
function extractText(payload: Record<string, unknown>): string {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing unknown _display to extract optional text
	const display = (payload._display as { text?: string } | undefined)?.text;
	if (typeof display === "string" && display.length > 0) return display.slice(0, 2000);
	if (typeof payload.content === "string") return payload.content.slice(0, 2000);
	if (typeof payload.text === "string") return payload.text.slice(0, 2000);
	if (typeof payload.output === "string") return payload.output.slice(0, 2000);
	if (typeof payload.path === "string") return payload.path;
	if (typeof payload.cmd === "string") return payload.cmd;
	return "";
}

const pendingEmbeddings: Array<{ rowid: number; text: string }> = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 *
 */
export function queueEmbedding(
	client: Client,
	rowid: number,
	bus: string,
	type: string,
	payload: Record<string, unknown>,
): void {
	if (!_embedder) return;
	if (!shouldEmbed(bus, type)) return;

	const text = extractText(payload);
	if (text.length < 10) return;

	pendingEmbeddings.push({ rowid, text: `${type}: ${text}` });

	flushTimer ??= setTimeout(() => {
		void flushEmbeddings(client);
	}, 500);
}

/**
 *
 */
async function flushEmbeddings(client: Client): Promise<void> {
	flushTimer = undefined;
	if (!_embedder || pendingEmbeddings.length === 0) return;

	const batch = pendingEmbeddings.splice(0, 20);
	const recall = new RecallStore(client);

	for (const item of batch) {
		try {
			const embedding = await _embedder.embed(item.text);
			await recall.setEventEmbedding(item.rowid, embedding);
		} catch {
			// Non-critical — skip failed embeddings
		}
	}

	if (pendingEmbeddings.length > 0) {
		flushTimer = setTimeout(() => {
			void flushEmbeddings(client);
		}, 100);
	}
}
