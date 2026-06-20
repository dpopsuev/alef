import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2eSession, HAVE_REAL_LLM } from "@dpopsuev/alef-testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodeIntelOrgan } from "../src/index.js";

describe.skipIf(!HAVE_REAL_LLM)("organ-code-intel — real LLM E2E", { tags: ["real-llm"] }, () => {
	let tempDir: string;
	let filePath: string;
	const uuid = randomUUID().replace(/-/g, "");

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "alef-lector-e2e-"));
		filePath = join(tempDir, "target.ts");
		writeFileSync(filePath, `export function getValue(): string {\n  return "${uuid}";\n}\n`, "utf-8");
	});

	afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

	it("LLM uses code.read then code.edit to modify a TypeScript function", async () => {
		const session = createE2eSession([createCodeIntelOrgan({ cwd: tempDir })]);
		const { events } = await session.send(
			`Read the file target.ts using code.read, then use code.edit to change the function to return "REPLACED" instead of the current UUID string. You MUST call code.read first, then code.edit.`,
		);
		const content = readFileSync(filePath, "utf-8");
		expect(
			events.some((e) => e.type === "llm.tool-start" && String(e.payload.name ?? "").includes("code.read")),
		).toBe(true);
		expect(
			events.some((e) => e.type === "llm.tool-start" && String(e.payload.name ?? "").includes("code.edit")),
		).toBe(true);
		expect(content).toContain("REPLACED");
		expect(content).not.toContain(uuid);
		session.dispose();
	}, 90_000);
});
