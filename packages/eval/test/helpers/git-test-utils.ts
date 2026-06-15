/**
 * Shared git test utilities — used by checker unit tests.
 *
 * Provides minimal git scaffolding without duplicating setup across files.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckerContext } from "../../src/evaluation.js";
import { initGitWorkspace } from "../../src/git-workspace.js";

// ---------------------------------------------------------------------------
// Repo lifecycle
// ---------------------------------------------------------------------------

const _tempDirs: string[] = [];

/** Register an afterEach cleanup — call once per describe block. */
export function useCleanup(afterEach: (fn: () => void) => void): void {
	afterEach(() => {
		for (const d of _tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
}

export interface TestRepo {
	workspace: string;
	seedSha: string;
}

export function makeTestRepo(prefix = "eval-test-"): TestRepo {
	const workspace = mkdtempSync(join(tmpdir(), prefix));
	_tempDirs.push(workspace);
	const seedSha = initGitWorkspace(workspace);
	return { workspace, seedSha };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export function git(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Write a file into the repo, stage it, and commit with a conventional message.
 * Creates parent directories automatically.
 */
export function commitFile(workspace: string, relativePath: string, content: string, message = "fix: add file"): void {
	const abs = join(workspace, relativePath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf-8");
	git("git add .", workspace);
	git(`git commit -m "${message.replace(/"/g, '\\"')}"`, workspace);
}

/**
 * Write a throwaway file and commit it with the given message.
 * Use when you only care about the commit message, not the file content.
 */
export function commitWithMessage(workspace: string, message: string): void {
	writeFileSync(join(workspace, `change-${Date.now()}.txt`), "change\n", "utf-8");
	git("git add .", workspace);
	git(`git commit -m "${message.replace(/"/g, '\\"')}"`, workspace);
}

// ---------------------------------------------------------------------------
// Checker context helper
// ---------------------------------------------------------------------------

/** Minimal CheckerContext for a given workspace. */
export function ctx(workspace: string, seedSha?: string): CheckerContext {
	return { workspace, spans: [], lastReply: "", ...(seedSha && { seedSha }) };
}
