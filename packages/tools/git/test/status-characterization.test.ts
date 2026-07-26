/**
 * Characterization: git.status's observable output must match real `git status --short`
 * byte-for-byte, regardless of what implementation produces it (raw execSync today,
 * LectorGitPort after the strangler cutover). This is the regression test for that
 * migration -- it is written and proven green against the current execSync
 * implementation before any port-based rewrite lands.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusFixture } from "@dpopsuev/alef-testkit/adapter";
import { afterEach, describe, expect, it } from "vitest";
import { createGitAdapter } from "../src/adapter.js";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function realGitStatusShort(cwd: string): string {
	return execSync("git status --short", { cwd, encoding: "utf-8" });
}

const tempDirs: string[] = [];

function tmpRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "alef-git-status-char-"));
	tempDirs.push(dir);
	git(dir, "init", "--initial-branch=main", "-q");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function statusOutput(cwd: string): Promise<string> {
	const f = new BusFixture();
	f.mount(createGitAdapter({ cwd }));
	const event = await f.call("git.status", {});
	f.dispose();
	return String((event.payload as { output?: unknown }).output ?? "");
}

describe("git.status observable output matches real `git status --short`", { tags: ["unit"] }, () => {
	it("clean working tree", async () => {
		const dir = tmpRepo();
		writeFileSync(join(dir, "committed.txt"), "hello\n");
		git(dir, "add", "committed.txt");
		git(dir, "commit", "-q", "-m", "initial");

		expect(await statusOutput(dir)).toBe(realGitStatusShort(dir));
	});

	it("untracked file", async () => {
		const dir = tmpRepo();
		writeFileSync(join(dir, "new.txt"), "new\n");

		expect(await statusOutput(dir)).toBe(realGitStatusShort(dir));
	});

	it("staged and unstaged modifications together", async () => {
		const dir = tmpRepo();
		writeFileSync(join(dir, "a.txt"), "a\n");
		writeFileSync(join(dir, "b.txt"), "b\n");
		git(dir, "add", "a.txt", "b.txt");
		git(dir, "commit", "-q", "-m", "initial");
		writeFileSync(join(dir, "a.txt"), "a-staged\n");
		git(dir, "add", "a.txt");
		writeFileSync(join(dir, "b.txt"), "b-unstaged\n");

		expect(await statusOutput(dir)).toBe(realGitStatusShort(dir));
	});

	it("a rename", async () => {
		const dir = tmpRepo();
		writeFileSync(join(dir, "old.txt"), "content that is long enough to be detected as a rename\n");
		git(dir, "add", "old.txt");
		git(dir, "commit", "-q", "-m", "initial");
		git(dir, "mv", "old.txt", "new.txt");

		expect(await statusOutput(dir)).toBe(realGitStatusShort(dir));
	});
});
