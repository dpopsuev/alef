import { StaleWorkspaceWrite, type WorkspaceEntry, type WorkspaceFilesystemPort, type WorkspaceWriteResult } from "@dpopsuev/alef-workspace/filesystem-port";
import type { ContentHash } from "@danypops/lector";
import { callLector, remoteErrorIs } from "./client.js";
import { registerWorkspace } from "./workspace-registration.js";

/** Lector's ContentHash is branded to keep a raw string from being passed where a real hash is required; this is the one boundary where a caller-observed hash value legitimately becomes one. */
function asContentHash(hash: string | null): ContentHash | null {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ContentHash is branded specifically so a raw string can't reach it by accident; this is the one intentional boundary crossing, for a value the port's own writeEntry previously returned as a hash.
	return hash === null ? null : (hash as ContentHash);
}

/** WorkspaceFilesystemPort backed by a real Lector daemon's workspace.rawRead/exactEdit. */
export class LectorFilesystemPort implements WorkspaceFilesystemPort {
	readonly version = 1 as const;

	constructor(private readonly root: string) {}

	async readEntry(path: string): Promise<WorkspaceEntry> {
		const workspaceId = await registerWorkspace(this.root);
		try {
			const read = await callLector("workspace.rawRead", { workspaceId, path });
			return { exists: true, content: read.content };
		} catch (error) {
			if (remoteErrorIs(error, "WorkspaceEntryNotFound")) return { exists: false };
			throw error;
		}
	}

	async writeEntry(path: string, expectedHash: string | null, content: string): Promise<WorkspaceWriteResult> {
		const workspaceId = await registerWorkspace(this.root);
		try {
			const outcome = await callLector("workspace.exactEdit", { workspaceId, path, expectedHash: asContentHash(expectedHash), content });
			return { previousHash: outcome.previousHash, newHash: outcome.newHash };
		} catch (error) {
			if (remoteErrorIs(error, "StaleExpectedHash")) throw new StaleWorkspaceWrite(path, expectedHash);
			throw error;
		}
	}
}
