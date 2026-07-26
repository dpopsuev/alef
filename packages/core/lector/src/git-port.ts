import type { GitDiffResult, GitLogEntry, GitStatusSummary, WorkspaceGitPort } from "@dpopsuev/alef-workspace/git-port";
import { callLector, remoteErrorIs } from "./client.js";
import { registerWorkspace } from "./workspace-registration.js";

/** WorkspaceGitPort backed by a real Lector daemon's workspace.gitStatus/gitLog/gitDiff. */
export class LectorGitPort implements WorkspaceGitPort {
	readonly version = 1 as const;

	constructor(private readonly root: string) {}

	async isGitRepository(): Promise<boolean> {
		try {
			await this.status();
			return true;
		} catch (error) {
			if (remoteErrorIs(error, "NotAGitRepository")) return false;
			throw error;
		}
	}

	async status(): Promise<GitStatusSummary> {
		const workspaceId = await registerWorkspace(this.root);
		const summary = await callLector("workspace.gitStatus", { workspaceId });
		return {
			files: summary.files.map((file) => ({
				path: file.path,
				renamedFrom: file.renamedFrom,
				indexStatus: file.indexStatus,
				workingDirStatus: file.workingDirStatus,
			})),
			ahead: summary.ahead,
			behind: summary.behind,
			current: summary.current,
			tracking: summary.tracking,
		};
	}

	async log(maxCount: number): Promise<readonly GitLogEntry[]> {
		const workspaceId = await registerWorkspace(this.root);
		const { entries } = await callLector("workspace.gitLog", { workspaceId, maxCount });
		return entries.map((entry) => ({
			sha: entry.sha,
			authorName: entry.authorName,
			authorEmail: entry.authorEmail,
			authoredAt: entry.authoredAt,
			message: entry.message,
		}));
	}

	async diff(ref: string | undefined, maxBytes: number): Promise<GitDiffResult> {
		const workspaceId = await registerWorkspace(this.root);
		const result = await callLector("workspace.gitDiff", { workspaceId, ref, maxBytes });
		return { diff: result.diff, truncated: result.truncated };
	}
}
