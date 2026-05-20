import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import stripAnsi from "strip-ansi";
import { expect } from "vitest";

const UPDATE = process.env.GOLDEN_UPDATE === "1";

export { stripAnsi as stripANSI };

export function goldenPath(testName: string, dir: string): string {
	const safe = testName.replace(/\//g, "_").replace(/\s+/g, "_");
	return join(dir, "testdata", `${safe}.golden`);
}

export function requireGolden(testName: string, got: string, dir: string): void {
	const stripped = stripAnsi(got);
	const path = goldenPath(testName, dir);

	if (UPDATE) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, stripped, "utf-8");
		return;
	}

	if (!existsSync(path)) {
		throw new Error(
			`Golden file missing: ${path}\nRun with GOLDEN_UPDATE=1 to create it.\n\n--- got ---\n${stripped}`,
		);
	}

	const want = readFileSync(path, "utf-8");
	expect(stripped, `golden mismatch for ${path}\n--- want ---\n${want}\n--- got ---\n${stripped}`).toBe(want);
}
