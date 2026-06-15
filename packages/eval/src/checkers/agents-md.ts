/**
 * AgentsMdChecker — verifies AGENTS.md is present and non-trivial.
 *
 * Score:
 *   0.0 — AGENTS.md missing
 *   0.5 — present but < 200 chars (trivial placeholder)
 *   1.0 — present, ≥ 200 chars, has at least one ## section heading
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Checker, CheckerContext, CheckerResult } from "../evaluation.js";

export function agentsMdCheck(): Checker {
	return {
		check({ workspace }: CheckerContext): CheckerResult {
			const path = join(workspace, "AGENTS.md");

			if (!existsSync(path)) {
				return {
					pass: false,
					score: 0,
					errors: ["AGENTS.md is missing from the workspace root."],
				};
			}

			const content = readFileSync(path, "utf-8");

			if (content.length < 200) {
				return {
					pass: false,
					score: 0.5,
					errors: [
						`AGENTS.md is only ${content.length} characters — too short to contain meaningful rules (minimum 200).`,
					],
				};
			}

			const hasSection = /^##\s+\S/m.test(content);
			if (!hasSection) {
				return {
					pass: false,
					score: 0.5,
					errors: ["AGENTS.md has no ## section headings — add sections like '## Commits' or '## Comments'."],
				};
			}

			return { pass: true, score: 1.0, errors: [] };
		},
	};
}
