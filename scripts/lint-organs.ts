/**
 * Organ framework linter — static analysis for framework contract violations.
 *
 * Checks all packages/organ-* source files and reports:
 *
 *   [STREAM]      typedAction handler that awaits a long-running operation
 *                 (network, subprocess, delegation) — should use typedStreamAction
 *   [SCHEMA]      z.string() required field without .min(1) — accepts empty string
 *   [NOTEST]      organ package with no test directory or test files
 *   [NOCOMPLIANCE]        organ has tests but none call organComplianceSuite — hard gate
 *   [NOCOMPLIANCE-STREAM] streaming tool (typedStreamAction) not in organComplianceSuite opts
 *   [IMPORT]      organ importing from another organ or runner — dep direction violation
 *
 * Usage:  npx tsx scripts/lint-organs.ts
 *         npx tsx scripts/lint-organs.ts --fail   (exit 1 on any violation)
 *
 * [NOCOMPLIANCE] is the hard gate: every organ with test files must call
 * organComplianceSuite(). This enforces schema rejection, structural checks,
 * and (optionally) streaming contracts for every organ automatically.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const ORGANS_DIR = join(ROOT, "packages");
const FAIL_ON_VIOLATIONS = process.argv.includes("--fail");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFile(path: string): string {
	try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function findFiles(dir: string, ext: string): string[] {
	if (!existsSync(dir)) return [];
	const results: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) results.push(...findFiles(full, ext));
		else if (entry.name.endsWith(ext)) results.push(full);
	}
	return results;
}

function rel(path: string): string {
	return relative(ROOT, path);
}

interface Violation {
	file: string;
	line: number;
	rule: string;
	message: string;
}

const violations: Violation[] = [];

function report(file: string, line: number, rule: string, message: string): void {
	violations.push({ file, line, rule, message });
	const loc = `${rel(file)}:${line}`;
	console.log(`[${rule}] ${loc}\n         ${message}`);
}

// ---------------------------------------------------------------------------
// Long-running operation patterns that suggest typedStreamAction
// ---------------------------------------------------------------------------

const LONG_RUNNING_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /\bfetch\s*\(/,                          label: "fetch() — network request" },
	{ pattern: /\bspawn\s*\(/,                          label: "spawn() — subprocess" },
	{ pattern: /child_process/,                         label: "child_process — subprocess" },
	{ pattern: /\bexecSync\s*\(|\bexec\s*\(/,          label: "exec() — subprocess" },
	{ pattern: /strategy\.send\s*\(/,                   label: "strategy.send() — delegation" },
	{ pattern: /\.send\s*\(\s*text/,                    label: ".send(text) — likely delegation" },
	{ pattern: /\baxios\b|\bgot\b|\bnode-fetch\b/,     label: "HTTP client — network request" },
];

// ---------------------------------------------------------------------------
// Check 1: typedAction with long-running awaits
// ---------------------------------------------------------------------------

function checkStreamingGap(file: string, content: string): void {
	const lines = content.split("\n");

	// Find each typedAction call
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.includes("typedAction(")) continue;
		if (line.includes("typedStreamAction(")) continue;

		// Collect the handler body: scan forward for the closing of the handler fn
		// Simple heuristic: look at the next 30 lines for long-running patterns
		const window = lines.slice(i, Math.min(i + 30, lines.length)).join("\n");

		for (const { pattern, label } of LONG_RUNNING_PATTERNS) {
			if (pattern.test(window)) {
				report(file, i + 1, "STREAM",
					`typedAction handler contains '${label}' — consider typedStreamAction for live progress`);
				break; // one violation per typedAction
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Check 2: z.string() without .min(1) on required fields
// ---------------------------------------------------------------------------

function checkSchemaStringMin(file: string, content: string): void {
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// z.string() that is NOT immediately followed by .min or .optional or .nullable
		// and is in a z.object() context (tool inputSchema)
		if (/\bz\.string\s*\(\s*\)/.test(line) &&
			!/\.min\(/.test(line) &&
			!/\.optional\(/.test(line) &&
			!/\.nullable\(/.test(line) &&
			!/\.default\(/.test(line)) {
			// Skip if it's in a comment or test file
			if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
			// Skip if clearly a non-required context (union, array element, etc.)
			if (/z\.union\s*\(|z\.array\s*\(/.test(line)) continue;

			report(file, i + 1, "SCHEMA",
				`z.string() without .min(1) — accepts empty string; add .min(1) to reject blank input`);
		}
	}
}

// ---------------------------------------------------------------------------
// Check 3: organ package missing tests
// ---------------------------------------------------------------------------

function checkTestCoverage(pkgDir: string, pkgName: string): void {
	const testDir = join(pkgDir, "test");
	if (!existsSync(testDir)) {
		report(join(pkgDir, "package.json"), 1, "NOTEST",
			`${pkgName} has no test/ directory — add contract tests`);
		return;
	}
	const testFiles = findFiles(testDir, ".test.ts");
	if (testFiles.length === 0) {
		report(testDir, 1, "NOTEST",
			`${pkgName}/test/ exists but contains no .test.ts files`);
		return;
	}

	// Hard gate: every organ with test files must call organComplianceSuite.
	// This ensures schema rejection, structural checks, and streaming contracts
	// are enforced automatically for every organ in CI.
	const hasCompliance = testFiles.some((f) => readFile(f).includes("organComplianceSuite"));
	if (!hasCompliance) {
		report(testFiles[0]!, 1, "NOCOMPLIANCE",
			`${pkgName} has tests but no organComplianceSuite() call — ` +
			`add: organComplianceSuite(() => createXxxOrgan(...)) to any test file`);
	}
}

// ---------------------------------------------------------------------------
// Check 3b: [NOCOMPLIANCE-STREAM] streaming tool not covered in compliance opts
// ---------------------------------------------------------------------------

function checkStreamingCompliance(pkgDir: string, pkgName: string): void {
	const testDir = join(pkgDir, "test");
	if (!existsSync(testDir)) return;
	const testFiles = findFiles(testDir, ".test.ts");
	const srcFiles = findFiles(join(pkgDir, "src"), ".ts");

	// Only check if organComplianceSuite is called
	const hasCompliance = testFiles.some((f) => readFile(f).includes("organComplianceSuite"));
	if (!hasCompliance) return;

	// Find streaming tool names from src: look for typedStreamAction calls
	// and extract the tool name from the same statement (heuristic: name: "x.y")
	const streamingToolNames: string[] = [];
	for (const srcFile of srcFiles) {
		const content = readFile(srcFile);
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (!lines[i].includes("typedStreamAction(")) continue;
			// Search for name: "x.y" in a 5-line window before the call
			const window = lines.slice(Math.max(0, i - 5), i + 2).join("\n");
			const match = window.match(/name:\s*["']([\w.]+)["']/);
			if (match) streamingToolNames.push(match[1]);
		}
	}

	if (streamingToolNames.length === 0) return;

	// Check each streaming tool appears in the organComplianceSuite streaming config
	for (const testFile of testFiles) {
		const content = readFile(testFile);
		if (!content.includes("organComplianceSuite")) continue;
		for (const toolName of streamingToolNames) {
			if (!content.includes(`"${toolName}"`) && !content.includes(`'${toolName}'`)) {
				report(testFile, 1, "NOCOMPLIANCE-STREAM",
					`${pkgName}: streaming tool '${toolName}' (typedStreamAction) is not declared ` +
					`in organComplianceSuite opts.streaming — ` +
					`add: streaming: { "${toolName}": { validPayload: { /* valid args */ } } }`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Check 4: organ importing from another organ or runner (dep direction)
// ---------------------------------------------------------------------------

function checkImportDirection(file: string, content: string, pkgName: string): void {
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim().startsWith("import")) continue;

		// Check imports of other organ-* packages (except spine, ai, session)
		const match = line.match(/from\s+["'](@dpopsuev\/alef-organ-[\w-]+)["']/);
		if (match) {
			const imported = match[1];
			// organ-llm and organ-dialog are legitimate deps (framework-level)
			// organ-prompt is legitimate (prompt engineering primitives)
			const allowed = ["organ-llm", "organ-dialog", "organ-prompt", "organ-memory"];
			const importedShort = imported.replace("@dpopsuev/alef-", "");
			if (!allowed.includes(importedShort) && importedShort !== pkgName) {
				report(file, i + 1, "IMPORT",
					`${pkgName} imports from ${imported} — organs should not depend on other organs`);
			}
		}

		// Check imports from runner
		const runnerMatch = line.match(/from\s+["']@dpopsuev\/alef-runner["']/);
		if (runnerMatch) {
			report(file, i + 1, "IMPORT",
				`${pkgName} imports from alef-runner — organs must not depend on the composition root`);
		}
	}
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

const organDirs = readdirSync(ORGANS_DIR, { withFileTypes: true })
	.filter((e) => e.isDirectory() && e.name.startsWith("organ-"))
	.map((e) => ({ name: e.name, dir: join(ORGANS_DIR, e.name) }));

console.log(`Scanning ${organDirs.length} organ packages...\n`);

for (const { name, dir } of organDirs) {
	const srcFiles = findFiles(join(dir, "src"), ".ts");

	for (const file of srcFiles) {
		const content = readFile(file);
		checkStreamingGap(file, content);
		checkSchemaStringMin(file, content);
		checkImportDirection(file, content, name);
	}

	checkTestCoverage(dir, name);
	checkStreamingCompliance(dir, name);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const counts: Record<string, number> = {};
for (const v of violations) counts[v.rule] = (counts[v.rule] ?? 0) + 1;

console.log(`\n${"─".repeat(60)}`);
console.log(`Found ${violations.length} violation(s) across ${organDirs.length} organs`);
for (const [rule, count] of Object.entries(counts).sort()) {
	console.log(`  [${rule}]  ${count}`);
}

if (FAIL_ON_VIOLATIONS && violations.length > 0) {
	process.exit(1);
}
