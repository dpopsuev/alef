/**
 * GitWorkspace — initialises a real git repository in the eval workspace.
 *
 * Used by PhaseEvaluationRunner when seedGitRepo: true.
 * Returns the baseline SHA so commit checkers can filter to agent-authored commits only.
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A realistic AGENTS.md following the open spec (https://www.agents.md).
 * Covers setup, testing, style, git — enough for an agent to work autonomously.
 * Modelled after real project AGENTS.md files used in production codebases.
 */
const DEFAULT_AGENTS_MD = `# Development Rules

## Setup

- Install: \`npm install\`
- Run tests: \`npx vitest run\`
- Type-check: \`npx tsc --noEmit\`

## Testing

- Run all tests before committing: \`npx vitest run\`
- If you create or modify a test file, run it and iterate until it passes.
- Tests live next to source files in \`src/\` or in a sibling \`test/\` directory.

## Code Style

- TypeScript strict mode. No \`any\` unless unavoidable.
- Top-level imports only — no inline \`await import()\`.
- No enums, no namespaces, no parameter properties.

## Commit Messages

\`<type>: <what changed>\` — lowercase, no period, 72 chars max.
Types: \`feat\` \`fix\` \`refactor\` \`test\` \`docs\` \`chore\` \`ci\`

Never:
- Bullet lists of changed files in the body
- Tracker IDs (PROJ-123, #456) in the subject line
- Mix unrelated changes in one commit

## Comments

Zero by default. One line only when the WHY is non-obvious to a reader who knows the codebase.

Never:
- Explain what the code does — the code says what; the comment says why
- Narrate the implementation step by step

## Git

- Only commit files you changed in this session.
- Stage explicit paths — never \`git add -A\` or \`git add .\`.
- Run \`git status\` before committing; verify only your files are staged.
- Never \`git reset --hard\`, \`git stash\`, or \`git commit --no-verify\`.
`;

function git(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export interface GitWorkspaceOptions {
	/** Content for AGENTS.md. Defaults to standard project rules. */
	agentsMd?: string;
}

/**
 * Initialise a git repo in `workspace`, write AGENTS.md, and make the seed commit.
 * Returns the seed commit SHA — checkers compare against this to find agent commits.
 */
export function initGitWorkspace(workspace: string, opts: GitWorkspaceOptions = {}): string {
	const agentsMd = opts.agentsMd ?? DEFAULT_AGENTS_MD;

	git("git init", workspace);
	// Neutral author — no eval signals in the commit metadata.
	git("git config user.email 'agent@alef.dev'", workspace);
	git("git config user.name 'Agent'", workspace);
	// Suppress advice output that could leak into agent context.
	git("git config advice.detachedHead false", workspace);

	writeFileSync(join(workspace, "AGENTS.md"), agentsMd, "utf-8");

	git("git add .", workspace);
	git("git commit -m 'chore: initial seed'", workspace);

	return git("git rev-parse HEAD", workspace);
}

/**
 * Return all commit SHAs authored by the agent (after the seed commit).
 */
export function getAgentCommits(
	workspace: string,
	seedSha: string,
): Array<{ sha: string; subject: string; body: string }> {
	let log: string;
	try {
		log = git(`git log ${seedSha}..HEAD --format=%H%x1F%s%x1F%b%x1E`, workspace);
	} catch {
		return [];
	}
	if (!log.trim()) return [];

	return log
		.split("\x1E")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const [sha, subject, ...bodyParts] = entry.split("\x1F");
			return { sha: sha.trim(), subject: subject.trim(), body: bodyParts.join("").trim() };
		})
		.filter((c) => c.sha.length > 0);
}

/**
 * Return the list of files changed by the agent relative to the seed commit.
 */
export function getChangedFiles(workspace: string, seedSha: string): string[] {
	try {
		const out = git(`git diff --name-only ${seedSha}..HEAD`, workspace);
		return out
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Return the full unified diff of agent changes as a string.
 */
export function getAgentDiff(workspace: string, seedSha: string, fileGlob = "*.ts"): string {
	try {
		return git(`git diff ${seedSha}..HEAD -- '${fileGlob}'`, workspace);
	} catch {
		return "";
	}
}
