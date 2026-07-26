/**
 * WorkspaceGitPort v1 -- read-only git queries against a workspace's repository.
 * Deliberately read-only: never a caller-influenced `-c` config override or a
 * mutating flag (clone/push/merge). A workspace with no `.git` directory is a real,
 * expected case, not an error condition every caller must special-case per method.
 */
export const WORKSPACE_GIT_PORT_VERSION = 1;

/**
 * One file's status, exposing index (staged) and working-directory (unstaged) status
 * separately rather than a combined code -- see `git status --porcelain` for the full
 * status-letter table (e.g. "M" modified, "A" added, "D" deleted, "?" untracked).
 */
export interface GitStatusEntry {
	readonly path: string;
	/** Present only for a rename/copy entry -- the path this one was renamed/copied from. */
	readonly renamedFrom?: string;
	readonly indexStatus: string;
	readonly workingDirStatus: string;
}

/** The working tree's overall status: files plus branch tracking state. */
export interface GitStatusSummary {
	readonly files: readonly GitStatusEntry[];
	readonly ahead: number;
	readonly behind: number;
	readonly current: string | null;
	readonly tracking: string | null;
}

/** One commit from `git log`. */
export interface GitLogEntry {
	readonly sha: string;
	readonly authorName: string;
	readonly authorEmail: string;
	/** ISO 8601, as git itself reports it -- never reformatted, to keep timezone info intact. */
	readonly authoredAt: string;
	readonly message: string;
}

/** Unified diff text, bounded -- a huge diff is truncated, never silently unbounded. */
export interface GitDiffResult {
	readonly diff: string;
	readonly truncated: boolean;
}

/** Read-only git queries against a workspace's repository. */
export interface WorkspaceGitPort {
	readonly version: 1;
	/** False for a workspace with no .git directory -- a real, expected case, not an error. */
	isGitRepository(): Promise<boolean>;
	/** The working tree's overall status: files plus branch tracking state. */
	status(): Promise<GitStatusSummary>;
	/** Most recent commits first, bounded to maxCount. */
	log(maxCount: number): Promise<readonly GitLogEntry[]>;
	/** Diff against `ref` (defaults to HEAD) of the current working tree, bounded to maxBytes. */
	diff(ref: string | undefined, maxBytes: number): Promise<GitDiffResult>;
}
