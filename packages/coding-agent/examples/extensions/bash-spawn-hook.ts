/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   alef -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@dpopsuev/alef-coding-agent";
import { createBashTool } from "@dpopsuev/alef-coding-agent";

export default function (alef: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, ALEF_SPAWN_HOOK: "1" },
		}),
	});

	alef.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
