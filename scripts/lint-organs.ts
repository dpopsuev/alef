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
// Long-running operation detectors that suggest typedStreamAction
// ---------------------------------------------------------------------------

// Each detector is a plain predicate — readable, no escape-character hell.
// String.includes() for literals; new RegExp(String.raw`...`) only where
// word boundaries genuinely need regex.
type Detector = { test: (code: string) => boolean; label: string };

const LONG_RUNNING_DETECTORS: Detector[] = [
	{
		test:  (code) => code.includes("fetch("),
		label: "fetch() — network request",
	},
	{
		// spawn( not preceded by a dot — rules out method.spawn(), ".spawn"
		test:  (code) => new RegExp(String.raw`(?<![.])\bspawn\(`).test(code),
		label: "spawn() — subprocess",
	},
	{
		// Actual import/require of child_process — not a comment or string mention
		test:  (code) =>
			code.includes(`"child_process"`) ||
			code.includes(`'child_process'`) ||
			code.includes('"node:child_process"') ||
			code.includes("'node:child_process'"),
		label: "child_process import — subprocess",
	},
	{
		test:  (code) => code.includes("execSync(") || code.includes("exec("),
		label: "exec() — subprocess",
	},
	{
		test:  (code) => code.includes("strategy.send("),
		label: "strategy.send() — delegation",
	},
	{
		test:  (code) => code.includes("axios") || code.includes("node-fetch"),
		label: "HTTP client library — network request",
	},
];

// ---------------------------------------------------------------------------
// Check 1: typedAction with long-running awaits
// ---------------------------------------------------------------------------

function checkStreamingGap(file: string, content: string): void {
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.includes("typedAction(")) continue;
		if (line.includes("typedStreamAction(")) continue;

		// 30-line forward window, comments stripped to avoid false positives
		// (e.g. "child_process is blocked" in a JSDoc block).
		const windowLines = lines.slice(i, Math.min(i + 30, lines.length));
		const codeWindow = windowLines
			.filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
			.join("\n");

		for (const { test, label } of LONG_RUNNING_DETECTORS) {
			if (test(codeWindow)) {
				report(file, i + 1, "STREAM",
					`typedAction handler contains '${label}' — consider typedStreamAction for live progress`);
				break;
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
// Check 3c: [NODISPLAY] typedAction handler without dual-channel display block
// ---------------------------------------------------------------------------

function checkDisplayChannel(file: string, content: string): void {
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.includes("typedAction(")) continue;
		if (line.includes("typedStreamAction(")) continue;

		// Skip when handler is a named function reference — display is inside the function.
		// Pattern: typedAction(TOOL, handleFoo) where handleFoo is defined elsewhere.
		const isDelegated = /typedAction\(\s*\w+\s*,\s*\w+\s*[),]/.test(line) && !line.includes("=>");
		if (isDelegated) continue;

		// 40-line forward window for the handler body, comments stripped
		const windowLines = lines.slice(i, Math.min(i + 40, lines.length));
		const codeWindow = windowLines
			.filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
			.join("\n");

		// Handler must return something (has a return or Promise.resolve) but no display wrapper
		const hasReturn = codeWindow.includes("return ") || codeWindow.includes("Promise.resolve(");
		const hasDisplay = codeWindow.includes("withDisplay(") || codeWindow.includes("withTruncatedDisplay(") || codeWindow.includes("withLlmContent(");

		if (hasReturn && !hasDisplay) {
			report(file, i + 1, "NODISPLAY",
				`typedAction handler returns without withDisplay() — TUI pill will be empty; wrap the return value with withDisplay()`);
		}
	}
}

// ---------------------------------------------------------------------------
// Check 4: [RAWTIMER] raw setTimeout/setInterval in organ src
// ---------------------------------------------------------------------------

function checkRawTimer(file: string, content: string): void {
	if (file.endsWith("watchdog.ts")) return;
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.includes("setTimeout(") && !line.includes("setInterval(")) continue;
		const suppress = lines[i - 1]?.includes("lint-ignore: RAWTIMER") || line.includes("lint-ignore: RAWTIMER");
		if (suppress) continue;
		const call = line.includes("setInterval(") ? "setInterval" : "setTimeout";
		report(file, i + 1, "RAWTIMER",
			`raw ${call}() — use Watchdog from @dpopsuev/alef-kernel; suppress with // lint-ignore: RAWTIMER <reason>`);
	}
}

// ---------------------------------------------------------------------------
// Check 5: organ importing from another organ or runner (dep direction)
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
			// organ-llm is a legitimate dep (framework-level)
			// organ-prompt is legitimate (prompt engineering primitives)
			const allowed = ["organ-llm", "organ-prompt", "organ-memory"];
			const importedShort = imported.replace("@dpopsuev/alef-", "");
			if (!allowed.includes(importedShort) && importedShort !== pkgName) {
				report(file, i + 1, "IMPORT",
					`${pkgName} imports from ${imported} — organs should not depend on other organs`);
			}
		}

				// Check imports from runner — package name or relative path
		const runnerPkgMatch = line.match(/from\s+["']@dpopsuev\/alef-runner["']/);
		if (runnerPkgMatch) {
			report(file, i + 1, "IMPORT",
				`${pkgName} imports from alef-runner — organs must not depend on the composition root`);
		}
		const runnerRelMatch = line.match(/from\s+["']([^"']*\/runner\/[^"']*)["']/);
		if (runnerRelMatch) {
			report(file, i + 1, "IMPORT",
				`${pkgName} imports via relative path into runner (${runnerRelMatch[1]}) — organs must not depend on the composition root`);
		}
	}
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

// organ-prompt is a utility package (Directives class), not a bus organ — no compliance needed.
const ORGAN_LINTER_EXCLUDE = new Set(["organ-prompt"]);

const organDirs = readdirSync(ORGANS_DIR, { withFileTypes: true })
	.filter((e) => e.isDirectory() && e.name.startsWith("organ-") && !ORGAN_LINTER_EXCLUDE.has(e.name))
	.map((e) => ({ name: e.name, dir: join(ORGANS_DIR, e.name) }));

console.log(`Scanning ${organDirs.length} organ packages...\n`);

for (const { name, dir } of organDirs) {
	const srcFiles = findFiles(join(dir, "src"), ".ts");
	const testFiles = findFiles(join(dir, "test"), ".ts");

	for (const file of srcFiles) {
		const content = readFile(file);
		checkStreamingGap(file, content);
		checkSchemaStringMin(file, content);
		checkDisplayChannel(file, content);
		checkImportDirection(file, content, name);
		checkRawTimer(file, content);
	}

	for (const file of testFiles) {
		const content = readFile(file);
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

// Hard gates: NOTEST, NOCOMPLIANCE*, and IMPORT block CI.
// Advisory: STREAM and SCHEMA are informational — they document gaps but do
// not block merging. Developers address them incrementally.
const HARD_GATE_RULES = new Set(["NOTEST", "NOCOMPLIANCE", "NOCOMPLIANCE-STREAM", "IMPORT", "RAWTIMER"]);
const hardViolations = violations.filter((v) => HARD_GATE_RULES.has(v.rule));

if (hardViolations.length > 0) {
	console.log(`\n${hardViolations.length} hard-gate violation(s) — fix before merging.`);
}
if (FAIL_ON_VIOLATIONS && hardViolations.length > 0) {
	process.exit(1);
}
