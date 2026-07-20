/**
 * Restart policy -- selects and executes the minimum restart scope
 * based on SBOM diff between the running and updated codebase.
 *
 * Scope execution:
 *   exit       -> process.exit(75) for external wrapper respawn
 *   tui        -> tui.stop() + bootTuiShell() + wireSession()
 *   supervisor -> runtime.stop() + runtime.start()
 *   adapter    -> agent.unload(name) + agent.load(newAdapter)
 *   none       -> no-op
 */

export type { RestartExecutor } from "../client/boot-types.js";

import type { RestartExecutor } from "../client/boot-types.js";
import type { RestartScope, Sbom } from "./sbom.js";
import { diffSbom, type SbomDiffResult } from "./sbom-diff.js";

/** Result of applying the restart policy. */
export interface RestartPolicyResult {
	scope: RestartScope;
	diff: SbomDiffResult;
	executed: boolean;
}

/**
 * Compare old and new SBOMs, determine the minimum restart scope,
 * and execute it through the provided primitives.
 *
 * Returns the scope that was applied. If the scope is "none",
 * nothing is executed. If the scope is "exit", this never returns.
 */
export async function applyRestartPolicy(
	oldSbom: Sbom,
	newSbom: Sbom,
	executor: RestartExecutor,
): Promise<RestartPolicyResult> {
	const diff = diffSbom(oldSbom, newSbom);

	if (diff.restartScope === "none") {
		return { scope: "none", diff, executed: false };
	}

	switch (diff.restartScope) {
		case "exit":
			await executor.exit();
			break;
		case "tui":
			await executor.restartTui();
			break;
		case "supervisor":
			await executor.restartSupervisor();
			break;
		case "adapter":
			await executor.reloadAdapters(diff.adaptersToReload);
			break;
	}

	return { scope: diff.restartScope, diff, executed: true };
}
