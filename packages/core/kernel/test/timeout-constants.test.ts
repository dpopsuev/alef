import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONVERSATION_TIMEOUT_MS,
	DEFAULT_LLM_TIMEOUT_MS,
	DEFAULT_STALL_TIMEOUT_MS,
	DEFAULT_TOOL_TIMEOUT_MS,
} from "../src/shared/execution.js";

describe("timeout constants", () => {
	it("DEFAULT_TOOL_TIMEOUT_MS is 300s (tools need more time than LLM HTTP calls)", () => {
		expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(300_000);
	});

	it("DEFAULT_LLM_TIMEOUT_MS is 120s (per-turn LLM call budget)", () => {
		expect(DEFAULT_LLM_TIMEOUT_MS).toBe(120_000);
	});

	it("DEFAULT_CONVERSATION_TIMEOUT_MS is 900s (15 min session budget)", () => {
		expect(DEFAULT_CONVERSATION_TIMEOUT_MS).toBe(900_000);
	});

	it("DEFAULT_STALL_TIMEOUT_MS is 180s (3 min inactivity budget)", () => {
		expect(DEFAULT_STALL_TIMEOUT_MS).toBe(180_000);
	});

	it("tool timeout > LLM timeout (tools can take longer than a single LLM call)", () => {
		expect(DEFAULT_TOOL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_LLM_TIMEOUT_MS);
	});
});

describe("single source of truth — no inline timeout env reads outside execution.ts", () => {
	it("ALEF_LLM_TIMEOUT_MS is only read in kernel/src/execution.ts", () => {
		const violations = findEnvReads("ALEF_LLM_TIMEOUT_MS", "packages/reasoner/src");
		expect(violations, `Found inline ALEF_LLM_TIMEOUT_MS reads:\n${violations.join("\n")}`).toHaveLength(0);
	});

	it("ALEF_TOOL_TIMEOUT_MS is only read in kernel/src/execution.ts", () => {
		const violations = findEnvReads("ALEF_TOOL_TIMEOUT_MS", "packages/reasoner/src");
		expect(violations, `Found inline ALEF_TOOL_TIMEOUT_MS reads:\n${violations.join("\n")}`).toHaveLength(0);
	});
});

function findEnvReads(envVar: string, searchDir: string): string[] {
	const root = join(import.meta.dirname, "../../..");
	const dir = join(root, searchDir);
	const violations: string[] = [];
	for (const file of walkTs(dir)) {
		const content = readFileSync(file, "utf-8");
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes(`process.env.${envVar}`) || lines[i].includes(`"${envVar}"`)) {
				violations.push(`${file.replace(`${root}/`, "")}:${i + 1}: ${lines[i].trim()}`);
			}
		}
	}
	return violations;
}

function walkTs(dir: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
			results.push(...walkTs(full));
		} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			results.push(full);
		}
	}
	return results;
}
