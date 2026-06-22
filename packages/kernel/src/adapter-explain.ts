import type { Adapter } from "./buses.js";

export function explainAdapter(adapter: Adapter): string {
	const lines: string[] = [];
	lines.push(`${adapter.name}${adapter.description ? ` — ${adapter.description}` : ""}`);

	if (adapter.labels?.length) {
		lines.push(`  labels: ${adapter.labels.join(", ")}`);
	}

	if (adapter.tools.length > 0) {
		lines.push(`  tools (${adapter.tools.length}):`);
		for (const tool of adapter.tools) {
			lines.push(
				`    ${tool.name} — ${tool.description?.split(".")[0] ?? "(no description)"}${tool.longRunning ? " [long-running]" : ""}`,
			);
		}
	}

	const subs = adapter.subscriptions;
	if (subs.motor.length > 0 || subs.sense.length > 0) {
		const motorCount = subs.motor.length;
		const senseCount = subs.sense.length;
		lines.push(`  subscriptions: ${motorCount} motor, ${senseCount} sense`);
	}

	const contributions = adapter.contributions;
	if (contributions) {
		const slots: string[] = [];
		if (contributions.port) slots.push(`port(${contributions.port.name})`);
		if (contributions["context.assemble"]) slots.push("context.assemble");
		if (contributions["agent.run"]) slots.push("agent.run");
		if (contributions["schema-resolver"]) slots.push("schema-resolver");
		if (contributions.skills) slots.push(`skills(${contributions.skills.length})`);
		if (contributions.tui) slots.push("tui");
		if (contributions.history) slots.push("history");
		if (slots.length > 0) lines.push(`  contributions: ${slots.join(", ")}`);
	}

	if (adapter.directives?.length) {
		lines.push(`  directives: ${adapter.directives.length} block(s), ${adapter.directives.join("").length} chars`);
	}

	return lines.join("\n");
}
/** @deprecated Use explainAdapter */
export const explainOrgan = explainAdapter;
