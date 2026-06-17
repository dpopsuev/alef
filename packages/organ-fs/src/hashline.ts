import { createHash } from "node:crypto";

const HASH_LEN = 4;

export function lineHash(text: string): string {
	const trimmed = text.replace(/[ \t\r]+$/, "");
	const hash = createHash("md5").update(trimmed).digest("hex");
	return hash.slice(0, HASH_LEN).toUpperCase();
}

export function fileHash(content: string): string {
	return createHash("md5").update(content).digest("hex").slice(0, 8).toUpperCase();
}

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

export interface HashlineEdit {
	kind: "swap" | "del" | "ins_pre" | "ins_post";
	startLine: number;
	endLine: number;
	body: string[];
}

export function parseHashlineEdits(input: string): HashlineEdit[] {
	const edits: HashlineEdit[] = [];
	const lines = input.split("\n");
	let i = 0;

	while (i < lines.length) {
		const line = lines[i].trim();
		if (!line) {
			i++;
			continue;
		}

		const swapMatch = line.match(/^SWAP\s+(\d+)(?:\.=(\d+))?$/);
		if (swapMatch) {
			const start = Number(swapMatch[1]);
			const end = swapMatch[2] ? Number(swapMatch[2]) : start;
			const body: string[] = [];
			i++;
			while (i < lines.length && lines[i].startsWith("+")) {
				body.push(lines[i].slice(1));
				i++;
			}
			edits.push({ kind: "swap", startLine: start, endLine: end, body });
			continue;
		}

		const delMatch = line.match(/^DEL\s+(\d+)(?:\.=(\d+))?$/);
		if (delMatch) {
			const start = Number(delMatch[1]);
			const end = delMatch[2] ? Number(delMatch[2]) : start;
			edits.push({ kind: "del", startLine: start, endLine: end, body: [] });
			i++;
			continue;
		}

		const insPreMatch = line.match(/^INS\.PRE\s+(\d+)$/);
		if (insPreMatch) {
			const anchor = Number(insPreMatch[1]);
			const body: string[] = [];
			i++;
			while (i < lines.length && lines[i].startsWith("+")) {
				body.push(lines[i].slice(1));
				i++;
			}
			edits.push({ kind: "ins_pre", startLine: anchor, endLine: anchor, body });
			continue;
		}

		const insPostMatch = line.match(/^INS\.POST\s+(\d+)$/);
		if (insPostMatch) {
			const anchor = Number(insPostMatch[1]);
			const body: string[] = [];
			i++;
			while (i < lines.length && lines[i].startsWith("+")) {
				body.push(lines[i].slice(1));
				i++;
			}
			edits.push({ kind: "ins_post", startLine: anchor, endLine: anchor, body });
			continue;
		}

		i++;
	}

	return edits;
}

export function applyHashlineEdits(
	content: string,
	edits: HashlineEdit[],
	expectedFileHash?: string,
): { result: string; error?: string } {
	if (expectedFileHash) {
		const actual = fileHash(content);
		if (actual !== expectedFileHash) {
			return {
				result: content,
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
				error: `Line range ${edit.startLine}-${edit.endLine} out of bounds (file has ${lines.length} lines)`,
			};
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
