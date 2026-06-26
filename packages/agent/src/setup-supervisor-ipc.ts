export function setupSupervisorIpc(blueprintUpgradePolicy: "rebuild_only" | "packages" | "self"): void {
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
	console.error(`[alef] supervisor upgrade policy: ${blueprintUpgradePolicy} (scope=${ipcScope})`);

	(globalThis as Record<string, unknown>).alefRequestRebuild = () => {
		if (ipcScope === "rebuild") {
			process.send?.({ type: "rebuild" });
		} else {
			process.send?.({ type: "update", scope: ipcScope, updateId: crypto.randomUUID() });
		}
	};
}
