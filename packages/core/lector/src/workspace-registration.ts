import { callLector } from "./client.js";

/**
 * Registers (and caches) the Lector workspaceId for one Alef adapter's own root -- always
 * via workspace.registerPath, never repo.fetch/package.resolveSource, so Lector's own
 * job scheduler treats it as "local" (never evicted or deprioritized in favor of
 * disposable fetched-repo work).
 */
const workspaceIdByRoot = new Map<string, string>();

/** Register (and cache) `root` as a Lector workspace, returning its stable workspaceId. */
export async function registerWorkspace(root: string): Promise<string> {
	const existing = workspaceIdByRoot.get(root);
	if (existing) return existing;
	const { workspaceId } = await callLector("workspace.registerPath", { path: root });
	workspaceIdByRoot.set(root, workspaceId);
	return workspaceId;
}

/** Clear the local root->workspaceId cache -- tests use this between isolated daemons. */
export function resetWorkspaceRegistrationForTests(): void {
	workspaceIdByRoot.clear();
}
