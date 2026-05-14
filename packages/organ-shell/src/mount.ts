import type { Organ, OrganBus, OrganResult } from "@dpopsuev/alef-nerve";
import { getShellEnv } from "./shell.js";
import { createPlatformShellAdapter } from "./shell-adapter.js";

// ---------------------------------------------------------------------------
// ShellOrgan
//
// Subscribes to "shell" organ on the bus. Handles one action:
//   exec — runs a shell command, collects stdout+stderr, returns text.
//
// Note: this first implementation is non-streaming. The full bash tool
// (coding-agent/src/core/tools/bash.ts) has onUpdate streaming for the TUI.
// That path is preserved — the shell organ is used for headless/bus-routed
// execution where streaming is not required.
// ---------------------------------------------------------------------------

export interface ShellOrganOptions {
	/** Working directory for command execution. */
	cwd: string;
	/** Optional shell path override. */
	shellPath?: string;
	/** Optional shell command prefix. */
	commandPrefix?: string;
	/** Optional bin dir to inject into PATH. */
	binDir?: string;
}

export function createShellOrgan(options: ShellOrganOptions): Organ {
	return {
		name: "shell",
		actions: ["exec"],

		mount(bus: OrganBus): () => void {
			return bus.handle("shell", async (action, args): Promise<OrganResult> => {
				if (action !== "exec") {
					return {
						ok: false,
						content: null,
						contentLength: 0,
						error: `shell organ: unknown action "${action}". Supported: exec.`,
					};
				}

				const command = String(args.command ?? "");
				const timeout = typeof args.timeout === "number" ? args.timeout : undefined;
				const resolvedCommand = options.commandPrefix ? `${options.commandPrefix}\n${command}` : command;

				const adapter = createPlatformShellAdapter();
				const chunks: Buffer[] = [];

				const { exitCode } = await adapter.execute({
					command: resolvedCommand,
					cwd: options.cwd,
					onData: (data) => chunks.push(data),
					timeout,
					shellPath: options.shellPath,
					env: getShellEnv({ binDir: options.binDir }),
				});

				const text = Buffer.concat(chunks).toString("utf-8");
				const content = [{ type: "text" as const, text: text || "(no output)" }];

				return {
					ok: exitCode === 0 || exitCode === null,
					content,
					contentLength: text.length,
					...(exitCode !== 0 && exitCode !== null ? { error: `Exit code ${exitCode}` } : {}),
				};
			});
		},
	};
}
