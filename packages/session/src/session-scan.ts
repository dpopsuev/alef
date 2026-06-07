import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SESSION_ROOT = join(homedir(), ".alef", "sessions");

export async function scanSessionFiles(
	visitor: (id: string, path: string, cwdHash: string) => Promise<void>,
): Promise<void> {
	try {
		const cwdHashes = await readdir(SESSION_ROOT);
		for (const cwdHash of cwdHashes) {
			const dir = join(SESSION_ROOT, cwdHash);
			try {
				const entries = await readdir(dir);
				for (const entry of entries) {
					if (!entry.endsWith(".jsonl")) continue;
					const id = entry.replace(".jsonl", "");
					const path = join(dir, entry);
					try {
						await visitor(id, path, cwdHash);
					} catch {
						/* skip unreadable entries */
					}
				}
			} catch {
				/* skip inaccessible directories */
			}
		}
	} catch {
		/* no sessions directory */
	}
}

export function sessionPath(id: string, cwdHash: string): string {
	return join(SESSION_ROOT, cwdHash, `${id}.jsonl`);
}
