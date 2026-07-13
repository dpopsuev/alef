import { createHash } from "node:crypto";

const HASH_LEN = 4;

/** Compute a 4-character uppercase MD5 hash of a line's trimmed content. */
export function lineHash(text: string): string {
	const trimmed = text.replace(/[ \t\r]+$/, "");
	const hash = createHash("md5").update(trimmed).digest("hex");
	return hash.slice(0, HASH_LEN).toUpperCase();
}

/** Compute an 8-character uppercase MD5 fingerprint of entire file content. */
export function fileHash(content: string): string {
	return createHash("md5").update(content).digest("hex").slice(0, 8).toUpperCase();
}

/** Format file content as hashline output with per-line content hashes and a file fingerprint header. */
export function formatHashline(content: string, offset = 1): string {
	const lines = content.split("\n");
	const fHash = fileHash(content);
	const header = `[#${fHash}]`;
	const body = lines.map((line, i) => {
		const num = offset + i;
		const hash = lineHash(line);
		return `${num}:${hash}|${line}`;
	});
	return `${header}\n${body.join("\n")}`;
}

/** A single hashline edit operation (swap, delete, insert-before, or insert-after). */
export interface HashlineEdit {
	kind: "swap" | "del" | "ins_pre" | "ins_post";
	startLine: number;
	endLine: number;
	body: string[];
	/** Optional content hashes for start/end lines (from read output). */
	startHash?: string;
	endHash?: string;
}

/** Failure reason returned by applyHashlineEdits. */
export type HashlineFailReason = "stale" | "oob" | "hash_mismatch" | "parse";

/** Parse a hashline edit script (SWAP/DEL/INS.PRE/INS.POST commands) into structured edits. */
export function parseHashlineEdits(input: string): HashlineEdit[] {
	const edits: HashlineEdit[] = [];
	const lines = input.split("\n");
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!.trim();
		if (!line) {
			i++;
			continue;
		}

		const swapMatch = line.match(/^SWAP\s+(\d+)(?::([0-9A-Fa-f]{4}))?(?:\.=(\d+)(?::([0-9A-Fa-f]{4}))?)?$/);
		if (swapMatch) {
			const start = Number(swapMatch[1]!);
			const startHash = swapMatch[2]?.toUpperCase();
			const end = swapMatch[3] ? Number(swapMatch[3]) : start;
			const endHash = swapMatch[4]?.toUpperCase() ?? (swapMatch[3] ? undefined : startHash);
			const body: string[] = [];
			i++;
			while (i < lines.length && lines[i]!.startsWith("+")) {
				body.push(lines[i]!.slice(1));
				i++;
			}
			edits.push({ kind: "swap", startLine: start, endLine: end, body, startHash, endHash });
			continue;
		}

		const delMatch = line.match(/^DEL\s+(\d+)(?::([0-9A-Fa-f]{4}))?(?:\.=(\d+)(?::([0-9A-Fa-f]{4}))?)?$/);
		if (delMatch) {
			const start = Number(delMatch[1]!);
			const startHash = delMatch[2]?.toUpperCase();
			const end = delMatch[3] ? Number(delMatch[3]) : start;
			const endHash = delMatch[4]?.toUpperCase() ?? (delMatch[3] ? undefined : startHash);
			edits.push({ kind: "del", startLine: start, endLine: end, body: [], startHash, endHash });
			i++;
			continue;
		}

		const insPreMatch = line.match(/^INS\.PRE\s+(\d+)(?::([0-9A-Fa-f]{4}))?$/);
		if (insPreMatch) {
			const anchor = Number(insPreMatch[1]!);
			const startHash = insPreMatch[2]?.toUpperCase();
			const body: string[] = [];
			i++;
			while (i < lines.length && lines[i]!.startsWith("+")) {
				body.push(lines[i]!.slice(1));
				i++;
			}
			edits.push({ kind: "ins_pre", startLine: anchor, endLine: anchor, body, startHash, endHash: startHash });
			continue;
		}

		const insPostMatch = line.match(/^INS\.POST\s+(\d+)(?::([0-9A-Fa-f]{4}))?$/);
		if (insPostMatch) {
			const anchor = Number(insPostMatch[1]!);
			const startHash = insPostMatch[2]?.toUpperCase();
			const body: string[] = [];
			i++;
			while (i < lines.length && lines[i]!.startsWith("+")) {
				body.push(lines[i]!.slice(1));
				i++;
			}
			edits.push({ kind: "ins_post", startLine: anchor, endLine: anchor, body, startHash, endHash: startHash });
			continue;
		}

		i++;
	}

	return edits;
}

/**
 *
 */
function verifyLineHashes(lines: string[], edit: HashlineEdit): string | undefined {
	if (edit.startHash) {
		const line = lines[edit.startLine - 1];
		if (line === undefined) return undefined;
		const actual = lineHash(line);
		if (actual !== edit.startHash) {
			return `Line ${edit.startLine} hash mismatch (expected ${edit.startHash}, got ${actual}). Re-read the file.`;
		}
	}
	if (edit.endHash && edit.endLine !== edit.startLine) {
		const line = lines[edit.endLine - 1];
		if (line === undefined) return undefined;
		const actual = lineHash(line);
		if (actual !== edit.endHash) {
			return `Line ${edit.endLine} hash mismatch (expected ${edit.endHash}, got ${actual}). Re-read the file.`;
		}
	}
	return undefined;
}

/** Apply parsed hashline edits to file content, with optional staleness check via file hash. */
export function applyHashlineEdits(
	content: string,
	edits: HashlineEdit[],
	expectedFileHash?: string,
): { result: string; error?: string; reason?: HashlineFailReason } {
	if (expectedFileHash) {
		const actual = fileHash(content);
		if (actual !== expectedFileHash) {
			return {
				result: content,
				reason: "stale",
				error: `File changed since last read (expected hash ${expectedFileHash}, got ${actual}). Re-read the file first.`,
			};
		}
	}

	const lines = content.split("\n");
	const sorted = [...edits].sort((a, b) => b.startLine - a.startLine);

	for (const edit of sorted) {
		const start = edit.startLine - 1;
		const end = edit.endLine;

		if (start < 0 || end > lines.length) {
			return {
				result: content,
				reason: "oob",
				error: `Line range ${edit.startLine}-${edit.endLine} out of bounds (file has ${lines.length} lines)`,
			};
		}

		const hashError = verifyLineHashes(lines, edit);
		if (hashError) {
			return { result: content, reason: "hash_mismatch", error: hashError };
		}

		switch (edit.kind) {
			case "swap":
				lines.splice(start, end - start, ...edit.body);
				break;
			case "del":
				lines.splice(start, end - start);
				break;
			case "ins_pre":
				lines.splice(start, 0, ...edit.body);
				break;
			case "ins_post":
				lines.splice(end, 0, ...edit.body);
				break;
		}
	}

	return { result: lines.join("\n") };
}

/** Extract [#FILEHASH] from the first line of a hashline script or read header. */
export function parseFileHashHeader(script: string): string | undefined {
	const match = script.trimStart().match(/^\[#([0-9A-Fa-f]{8})\]/);
	return match?.[1]?.toUpperCase();
}
