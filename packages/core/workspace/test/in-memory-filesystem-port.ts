import { createHash } from "node:crypto";
import type { WorkspaceEntry, WorkspaceFilesystemPort, WorkspaceWriteResult } from "../src/filesystem-port.js";
import { StaleWorkspaceWrite } from "../src/filesystem-port.js";

function hashOf(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Minimal in-memory WorkspaceFilesystemPort -- a reference implementation for conformance tests. */
export class InMemoryFilesystemPort implements WorkspaceFilesystemPort {
	readonly version = 1 as const;
	private readonly files = new Map<string, string>();

	async readEntry(path: string): Promise<WorkspaceEntry> {
		const content = this.files.get(path);
		return content === undefined ? { exists: false } : { exists: true, content };
	}

	async writeEntry(path: string, expectedHash: string | null, content: string): Promise<WorkspaceWriteResult> {
		const current = this.files.get(path);
		const currentHash = current === undefined ? null : hashOf(current);
		if (currentHash !== expectedHash) throw new StaleWorkspaceWrite(path, expectedHash);
		this.files.set(path, content);
		return { previousHash: currentHash, newHash: hashOf(content) };
	}
}
