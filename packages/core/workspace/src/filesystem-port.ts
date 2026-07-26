/**
 * WorkspaceFilesystemPort v1 -- raw file access for one workspace: read a path's current
 * content, or apply a hash-guarded write. A capability adapter (fs) implements this by
 * translating tool calls into port calls; it owns none of the actual read/write logic
 * itself once backed by a real workspace provider (e.g. Lector).
 */
export const WORKSPACE_FILESYSTEM_PORT_VERSION = 1;

/** A workspace entry that does not (yet) exist. Distinguished from empty content. */
export interface MissingWorkspaceEntry {
	readonly exists: false;
}

/** A workspace entry that exists, with its raw content. */
export interface PresentWorkspaceEntry {
	readonly exists: true;
	readonly content: string;
}

/** Whatever readEntry finds at a path -- present with content, or missing entirely. */
export type WorkspaceEntry = MissingWorkspaceEntry | PresentWorkspaceEntry;

/** Rejects a write whose expectedHash no longer matches the entry's current state. */
export class StaleWorkspaceWrite extends Error {
	constructor(
		readonly path: string,
		readonly expectedHash: string | null,
	) {
		super(`stale write at "${path}": content changed since expectedHash ${expectedHash ?? "null (expected not-yet-existing)"} was observed`);
		this.name = "StaleWorkspaceWrite";
	}
}

/** What actually changed as a result of one writeEntry call. */
export interface WorkspaceWriteResult {
	readonly previousHash: string | null;
	readonly newHash: string;
}

/** Raw file access for one workspace, with hash-guarded writes. */
export interface WorkspaceFilesystemPort {
	readonly version: 1;
	/** The entry's current content, or that it does not exist. */
	readEntry(path: string): Promise<WorkspaceEntry>;
	/**
	 * @param expectedHash The hash the caller last observed at `path`, or `null` to assert
	 *   the path does not yet exist.
	 * @throws StaleWorkspaceWrite when the entry's current hash does not match `expectedHash`.
	 */
	writeEntry(path: string, expectedHash: string | null, content: string): Promise<WorkspaceWriteResult>;
}
