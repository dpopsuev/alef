/**
 * Protected Paths Extension
 *
 * Blocks write and edit operations to protected paths.
 * Useful for preventing accidental modifications to sensitive files.
 */

import type { ExtensionAPI } from "@dpopsuev/alef-coding-agent";

export default function (alef: ExtensionAPI) {
	const protectedPaths = [".env", ".git/", "node_modules/"];

	alef.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "file_write" && event.toolName !== "file_edit") {
			return undefined;
		}

		const path = event.input.path as string;
		const isProtected = protectedPaths.some((p) => path.includes(p));

		if (isProtected) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
			}
			return { block: true, reason: `Path "${path}" is protected` };
		}

		return undefined;
	});
}
