import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : [path];
	});
}

describe("generic documentation boundary", () => {
	it("contains no host-runtime names in source or documentation", () => {
		const root = join(import.meta.dirname, "..");
		const files = [...sourceFiles(join(root, "src")), join(root, "README.md")];
		const forbidden = ["al" + "ef", "p" + "i"];
		for (const file of files) {
			const content = readFileSync(file, "utf8").toLowerCase();
			for (const name of forbidden) expect(content).not.toMatch(new RegExp(`\\b${name}\\b`, "u"));
		}
	});
});
