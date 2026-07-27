import type { GitDiffResult, GitLogEntry, GitStatusSummary, WorkspaceGitPort } from "@dpopsuev/alef-workspace/git-port";
import { simpleGit } from "simple-git";

/** Raised when a caller-influenced string cannot safely reach git's argv. */
export class UnsafeGitArgument extends Error {
	constructor(readonly value: string) {
		super(`"${value}" cannot be used as a git argument -- it would be interpreted as a flag, not a literal value`);
		this.name = "UnsafeGitArgument";
	}
}

/**
 * Rejects any value git's own argv parser could interpret as a flag rather than a literal
 * ref -- the root cause of most git CLI injection CVEs (`--upload-pack`, `--exec`, `-c`
 * config overrides all require the argument to start with `-`). This port is read-only and
 * never needs to pass a caller-influenced flag, so it's a hard rejection.
 */
function assertSafeGitArgument(value: string): void {
	if (value.startsWith("-")) throw new UnsafeGitArgument(value);
}

/**
 * WorkspaceGitPort backed directly by simple-git, no daemon in the loop. Git status/log/diff
 * are cheap and stateless -- none of a daemon's real value (warm LSP index, persistent symbol
 * graph) applies here, and Lector's own git backend is this same simple-git call with no
 * caching layered on top of it.
 */
export class SimpleGitPort implements WorkspaceGitPort {
	readonly version = 1;
	private readonly git: ReturnType<typeof simpleGit>;

	constructor(cwd: string) {
		this.git = simpleGit(cwd);
	}

	async isGitRepository(): Promise<boolean> {
		try {
			return await this.git.checkIsRepo();
		} catch {
			return false;
		}
	}

	async status(): Promise<GitStatusSummary> {
		const result = await this.git.status();
		return {
			files: result.files.map((file) =>
				file.from
					? { path: file.path, renamedFrom: file.from, indexStatus: file.index, workingDirStatus: file.working_dir }
					: { path: file.path, indexStatus: file.index, workingDirStatus: file.working_dir },
			),
			ahead: result.ahead,
			behind: result.behind,
			current: result.current,
			tracking: result.tracking,
		};
	}

	async log(maxCount: number): Promise<readonly GitLogEntry[]> {
		const result = await this.git.log({ maxCount });
		return result.all.map((entry) => ({
			sha: entry.hash,
			authorName: entry.author_name,
			authorEmail: entry.author_email,
			authoredAt: entry.date,
			message: entry.message,
		}));
	}

	async diff(ref: string | undefined, maxBytes: number): Promise<GitDiffResult> {
		const args: string[] = [];
		if (ref !== undefined) {
			assertSafeGitArgument(ref);
			args.push(ref);
		}
		// Marks the end of options: even a validated ref can never be reinterpreted as a flag by
		// git itself past this point.
		args.push("--");
		const raw = await this.git.diff(args);
		const truncated = raw.length > maxBytes;
		return { diff: truncated ? raw.slice(0, maxBytes) : raw, truncated };
	}
}
