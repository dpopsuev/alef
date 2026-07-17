/**
 * lintCheck — runs Biome on files changed by the agent and reports violations.
 *
 * Only scans files added or modified since the seed commit (git diff --name-only).
 * Ignores files the agent did not touch so seed noise never penalises the score.
 *
 * Score:
 *   1.0 — zero diagnostics on changed files
 *   0.0 — any error-level diagnostic
 *   partial — warnings only (score = 1 - warnings/10, floor 0.5)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Checker, CheckerContext, CheckerResult } from "../evaluation.js";
import { getChangedFiles } from "../git-workspace.js";
import { monorepoPath } from "./tooling-paths.js";

const BIOME = monorepoPath("node_modules", ".bin", "biome");

interface BiomeDiagnostic {
	severity: "error" | "warning" | "information" | "hint";
	message: { text: string };
	location?: { path?: { file?: string }; span?: { start?: { line?: number } } };
}

interface BiomeReport {
	diagnostics: BiomeDiagnostic[];
	summary: { errors: number; warnings: number };
}

/**
 *
 */
function runBiome(workspace: string, files: string[]): Promise<{ report: BiomeReport; ok: boolean }> {
	return new Promise((resolve) => {
		if (!existsSync(BIOME)) {
			resolve({ report: { diagnostics: [], summary: { errors: 0, warnings: 0 } }, ok: true });
			return;
		}
		let output = "";
		const proc = spawn(BIOME, ["check", "--reporter", "json", "--error-on-warnings=false", ...files], {
			cwd: workspace,
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.stdout.on("data", (d: Buffer) => {
			output += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			output += d.toString();
		});
		proc.on("close", (code) => {
			try {
				// Biome outputs JSON on the last non-empty line.
				const jsonLine =
					output
						.split("\n")
						.filter((l) => l.trim().startsWith("{"))
						.at(-1) ?? "{}";
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns any; shape validated by downstream usage
				const report = JSON.parse(jsonLine) as BiomeReport;
				resolve({ report, ok: (code ?? 1) === 0 });
			} catch {
				resolve({ report: { diagnostics: [], summary: { errors: 0, warnings: 0 } }, ok: true });
			}
		});
	});
}

/**
 *
 */
export interface LintCheckOptions {
	/** Seed SHA from initGitWorkspace(). Uses ctx.seedSha when omitted. */
	seedSha?: string;
	/** File extensions to lint. Default: [".ts"]. */
	extensions?: string[];
}

/**
 *
 */
export function lintCheck(opts?: Partial<LintCheckOptions>): Checker {
	return {
		async check({ workspace, seedSha: ctxSeedSha }: CheckerContext): Promise<CheckerResult> {
			const resolvedSha = opts?.seedSha ?? ctxSeedSha;
			const extensions = opts?.extensions ?? [".ts"];

			// No git repo — skip gracefully (e.g. fixture checks).
			if (!resolvedSha) return { pass: true, score: 1.0, errors: [] };

			const changed = getChangedFiles(workspace, resolvedSha)
				.filter((f) => extensions.some((ext) => f.endsWith(ext)))
				.map((f) => join(workspace, f));

			if (changed.length === 0) return { pass: true, score: 1.0, errors: [] };

			const { report } = await runBiome(workspace, changed);
			const errors = report.diagnostics.filter((d) => d.severity === "error");
			const warnings = report.diagnostics.filter((d) => d.severity === "warning");

			if (errors.length > 0) {
				return {
					pass: false,
					score: 0,
					errors: errors.map((d) => {
						const file = d.location?.path?.file ?? "";
						const line = d.location?.span?.start?.line ?? 0;
						return `${file}:${line} ${d.message.text}`;
					}),
				};
			}

			if (warnings.length > 0) {
				// eslint-disable-next-line no-magic-numbers
				const score = Math.max(0.5, 1 - warnings.length / 10);
				return {
					pass: false,
					score,
					// eslint-disable-next-line no-magic-numbers
					errors: warnings.slice(0, 5).map((d) => `warning: ${d.message.text}`),
				};
			}

			return { pass: true, score: 1.0, errors: [] };
		},
	};
}
