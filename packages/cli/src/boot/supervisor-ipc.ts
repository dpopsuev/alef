import { setRebuildPort } from "./rebuild-port.js";

/**
 * When spawned under an external process supervisor (ALEF_SUPERVISOR=1),
 * ack handoff_prepare and route rebuild requests over IPC.
 */
export function setupSupervisorIpc(
	blueprintUpgradePolicy: "rebuild_only" | "packages" | "self" = "rebuild_only",
): void {
	if (process.env.ALEF_SUPERVISOR !== "1" || typeof process.send !== "function") return;

	process.on("message", (msg: unknown) => {
		if (typeof msg !== "object" || msg === null) return;
		const message = msg as { type?: string; envelope?: { updateId?: string } };
		if (message.type === "handoff_prepare" && message.envelope?.updateId) {
			process.send?.({ type: "handoff_ack", updateId: message.envelope.updateId });
		}
	});

	const ipcScope =
		blueprintUpgradePolicy === "self" ? "self" : blueprintUpgradePolicy === "packages" ? "packages" : "rebuild";

	setRebuildPort({
		requestRebuild(): Promise<void> {
			if (ipcScope === "rebuild") {
				process.send?.({ type: "rebuild" });
			} else {
				process.send?.({ type: "update", scope: ipcScope, updateId: crypto.randomUUID() });
			}
			return Promise.resolve();
		},
	});
}
