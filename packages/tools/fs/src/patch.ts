/**
 * fs.patch — multi-file atomic patch tool.
 *
 * Format:
 *   *** Begin Patch
 *   *** Add File: path
 *   +line to add
 *   *** Update File: path
 *   @@ optional context hint
 *    context line (space prefix)
 *   -removed line (dash prefix)
 *   +added line (plus prefix)
 *   *** Delete File: path
 *   *** Move File: src -> dst
 *   *** End Patch
 *
 * Validation runs before any file is touched. If any operation fails
 * validation, no files are modified.
 */

import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite } from "./fs-utils.js";

/** Discriminator for the four patch operation types. */
export type PatchOpKind = "add" | "update" | "delete" | "move";

/** A single parsed patch operation with its target path, optional destination, and diff lines. */
export interface PatchOp {
	kind: PatchOpKind;
	path: string;
	dest?: string;
	lines: string[];
}

/** Result of applying a single patch operation, with line-change counts and optional error. */
export interface PatchResult {
	path: string;
	operation: PatchOpKind;
	linesAdded: number;
	linesRemoved: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Parse a multi-file patch block delimited by Begin/End Patch markers into structured operations. */
export function parsePatch(text: string): PatchOp[] {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => l.trim() === "*** Begin Patch");
	const end = lines.findIndex((l) => l.trim() === "*** End Patch");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error('fs.patch: missing "*** Begin Patch" / "*** End Patch" markers');
	}

	const ops: PatchOp[] = [];
	let current: PatchOp | null = null;

	for (let i = start + 1; i < end; i++) {
		const line = lines[i] ?? "";
		const addMatch = line.match(/^\*\*\* Add File:\s*(.+)/);
		const updateMatch = line.match(/^\*\*\* Update File:\s*(.+)/);
		const deleteMatch = line.match(/^\*\*\* Delete File:\s*(.+)/);
		const moveMatch = line.match(/^\*\*\* Move File:\s*(.+?)\s*->\s*(.+)/);

		if (addMatch ?? updateMatch ?? deleteMatch ?? moveMatch) {
			if (current) ops.push(current);
			if (moveMatch) {
				current = { kind: "move", path: moveMatch[1]!.trim(), dest: moveMatch[2]!.trim(), lines: [] };
			} else if (addMatch) {
				current = { kind: "add", path: addMatch[1]!.trim(), lines: [] };
			} else if (updateMatch) {
				current = { kind: "update", path: updateMatch[1]!.trim(), lines: [] };
			} else if (deleteMatch) {
				current = { kind: "delete", path: deleteMatch[1]!.trim(), lines: [] };
			}
		} else if (current) {
			current.lines.push(line);
		}
	}
	if (current) ops.push(current);
	return ops;
}

// ---------------------------------------------------------------------------
// Patch applier — line-level diff for Update
// ---------------------------------------------------------------------------

/** Apply a set of diff lines (context, additions, removals) to original file content. */
function applyUpdateLines(original: string, diffLines: string[]): string {
	const fileLines = original.split("\n");
	const hunks = splitIntoHunks(diffLines);

	let result = fileLines;
	for (const hunk of hunks) {
		result = applyHunk(result, hunk);
	}
	return result.join("\n");
}

/** Split diff lines into before/after hunk pairs, separating context from additions and removals. */
function splitIntoHunks(lines: string[]): Array<{ before: string[]; after: string[] }> {
	// Collect all lines into a single before/after sequence.
	const before: string[] = [];
	const after: string[] = [];
	for (const line of lines) {
		if (line.startsWith("@@")) continue;
		if (line.startsWith("-")) {
			before.push(line.slice(1));
		} else if (line.startsWith("+")) {
			after.push(line.slice(1));
		} else {
			const ctx = line.startsWith(" ") ? line.slice(1) : line;
			before.push(ctx);
			after.push(ctx);
		}
	}
	return [{ before, after }];
}

/** Locate a hunk's before-context in the file and replace it with the after-content. */
function applyHunk(fileLines: string[], hunk: { before: string[]; after: string[] }): string[] {
	if (hunk.before.length === 0) {
		return [...fileLines, ...hunk.after];
	}

	// Find the before sequence in fileLines.
	for (let i = 0; i <= fileLines.length - hunk.before.length; i++) {
		const slice = fileLines.slice(i, i + hunk.before.length);
		if (slice.every((l, j) => l === hunk.before[j])) {
			return [...fileLines.slice(0, i), ...hunk.after, ...fileLines.slice(i + hunk.before.length)];
		}
	}
	throw new Error(`fs.patch: could not find context to update — hunk not found in file`);
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/** Validate patch operations against the filesystem, returning error messages for any conflicts. */
export async function validateOps(ops: PatchOp[], resolveAbs: (p: string) => string): Promise<string[]> {
	const errors: string[] = [];
	for (const op of ops) {
		const abs = resolveAbs(op.path);
		if (op.kind === "add") {
			try {
				await readFile(abs);
				errors.push(`add: '${op.path}' already exists`);
			} catch {
				/* ok */
			}
		}
		if (op.kind === "update" || op.kind === "delete" || op.kind === "move") {
			try {
				await readFile(abs);
			} catch {
				errors.push(`${op.kind}: '${op.path}' not found`);
			}
		}
		if (op.kind === "move" && op.dest) {
			const dest = resolveAbs(op.dest);
			try {
				await readFile(dest);
				errors.push(`move: destination '${op.dest}' already exists`);
			} catch {
				/* ok */
			}
		}
	}
	return errors;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

type Applier = (
	op: PatchOp,
	resolveAbs: (p: string) => string,
	runFmt: (abs: string) => Promise<void>,
) => Promise<Pick<PatchResult, "linesAdded" | "linesRemoved">>;

const APPLIERS: Record<PatchOpKind, Applier> = {
	add: async (op, resolveAbs, runFmt) => {
		const abs = resolveAbs(op.path);
		const content = op.lines.map((l) => (l.startsWith("+") ? l.slice(1) : l)).join("\n");
		await mkdir(dirname(abs), { recursive: true });
		await atomicWrite(abs, content);
		await runFmt(abs);
		return { linesAdded: content.split("\n").length, linesRemoved: 0 };
	},
	update: async (op, resolveAbs, runFmt) => {
		const abs = resolveAbs(op.path);
		const original = await readFile(abs, "utf-8");
		const updated = applyUpdateLines(original, op.lines);
		await atomicWrite(abs, updated);
		await runFmt(abs);
		return {
			linesAdded: Math.max(0, updated.split("\n").length - original.split("\n").length),
			linesRemoved: Math.max(0, original.split("\n").length - updated.split("\n").length),
		};
	},
	delete: async (op, resolveAbs) => {
		await unlink(resolveAbs(op.path));
		return { linesAdded: 0, linesRemoved: 0 };
	},
	move: async (op, resolveAbs, runFmt) => {
		const abs = resolveAbs(op.path);
		const dest = resolveAbs(op.dest ?? "");
		await mkdir(dirname(dest), { recursive: true });
		await rename(abs, dest);
		if (op.lines.length > 0) {
			const content = await readFile(dest, "utf-8");
			const updated = applyUpdateLines(content, op.lines);
			await atomicWrite(dest, updated);
			await runFmt(dest);
		}
		return { linesAdded: 0, linesRemoved: 0 };
	},
};

/** Apply a sequence of patch operations (add, update, delete, move) to the filesystem. */
export async function applyOps(
	ops: PatchOp[],
	resolveAbs: (p: string) => string,
	runFmt: (abs: string) => Promise<void>,
): Promise<PatchResult[]> {
	const results: PatchResult[] = [];
	for (const op of ops) {
		const applier = APPLIERS[op.kind];
		const { linesAdded, linesRemoved } = await applier(op, resolveAbs, runFmt);
		results.push({ path: op.path, operation: op.kind, linesAdded, linesRemoved });
	}
	return results;
}
