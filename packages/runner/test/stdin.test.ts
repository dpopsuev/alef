import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readStdinLines } from "../src/stdin.js";

function makeReadable(lines: string[]): Readable {
	return Readable.from(lines.map((l) => `${l}\n`).join(""));
}

async function collect(readable: Readable): Promise<string[]> {
	// Temporarily swap process.stdin
	const original = process.stdin;
	Object.defineProperty(process, "stdin", { value: readable, configurable: true });
	// Mark as non-TTY so no prompt prefix is added
	Object.defineProperty(readable, "isTTY", { value: false });

	const results: string[] = [];
	try {
		for await (const line of readStdinLines()) {
			results.push(line);
		}
	} finally {
		Object.defineProperty(process, "stdin", { value: original, configurable: true });
	}
	return results;
}

describe("readStdinLines", () => {
	it("yields each non-empty line", async () => {
		const lines = await collect(makeReadable(["hello", "world"]));
		expect(lines).toEqual(["hello", "world"]);
	});

	it("trims whitespace from lines", async () => {
		const lines = await collect(makeReadable(["  hello  ", "  world  "]));
		expect(lines).toEqual(["hello", "world"]);
	});

	it("skips blank lines", async () => {
		const lines = await collect(makeReadable(["hello", "", "world"]));
		expect(lines).toEqual(["hello", "world"]);
	});

	it("returns empty array for empty input", async () => {
		const lines = await collect(makeReadable([]));
		expect(lines).toEqual([]);
	});
});
