import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../src/client.js";
import { LectorGitPort } from "../src/git-port.js";
import { resetWorkspaceRegistrationForTests } from "../src/workspace-registration.js";
import { type IsolatedLectorDaemon, startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.js";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("LectorGitPort", { tags: ["integration"], timeout: 30_000 }, () => {
	let daemon: IsolatedLectorDaemon;

	beforeAll(async () => {
		daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
	});

	afterAll(async () => {
		resetLectorClientForTests();
		await daemon.stop();
	});

	it("reports false for a workspace with no .git directory", async () => {
		const port = new LectorGitPort(daemon.workspaceRoot);
		expect(await port.isGitRepository()).toBe(false);
	});
});

describe("LectorGitPort against a real repository", { tags: ["integration"], timeout: 30_000 }, () => {
	let daemon: IsolatedLectorDaemon;
	let repoPath: string;

	beforeAll(async () => {
		daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		repoPath = daemon.workspaceRoot;
		git(repoPath, "init", "--initial-branch=main", "-q");
		git(repoPath, "config", "user.email", "test@example.com");
		git(repoPath, "config", "user.name", "Test");
		writeFileSync(join(repoPath, "committed.txt"), "hello\n");
		git(repoPath, "add", "committed.txt");
		git(repoPath, "commit", "-q", "-m", "initial commit");
		writeFileSync(join(repoPath, "untracked.txt"), "new\n");
	});

	afterAll(async () => {
		resetLectorClientForTests();
		await daemon.stop();
	});

	it("reports a real git repository", async () => {
		resetWorkspaceRegistrationForTests();
		const port = new LectorGitPort(repoPath);
		expect(await port.isGitRepository()).toBe(true);
	});

	it("status reports the untracked file and current branch", async () => {
		resetWorkspaceRegistrationForTests();
		const port = new LectorGitPort(repoPath);
		const status = await port.status();
		expect(status.current).toBe("main");
		expect(status.files.some((f) => f.path === "untracked.txt")).toBe(true);
	});

	it("log reports the initial commit, bounded to maxCount", async () => {
		resetWorkspaceRegistrationForTests();
		const port = new LectorGitPort(repoPath);
		const entries = await port.log(10);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.message).toBe("initial commit");
		expect(entries[0]?.authorEmail).toBe("test@example.com");
	});

	it("diff reports no differences against HEAD for an unmodified tracked file", async () => {
		resetWorkspaceRegistrationForTests();
		const port = new LectorGitPort(repoPath);
		const result = await port.diff(undefined, 10_000);
		expect(result.diff).toBe("");
		expect(result.truncated).toBe(false);
	});
});
