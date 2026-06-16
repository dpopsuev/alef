import type { Organ } from "./buses.js";

export function explainOrgan(organ: Organ): string {
	const lines: string[] = [];
	lines.push(`${organ.name}${organ.description ? ` — ${organ.description}` : ""}`);

	if (organ.labels?.length) {
		lines.push(`  labels: ${organ.labels.join(", ")}`);
	}

	if (organ.tools.length > 0) {
		lines.push(`  tools (${organ.tools.length}):`);
		for (const tool of organ.tools) {
			lines.push(
				`    ${tool.name} — ${tool.description?.split(".")[0] ?? "(no description)"}${tool.longRunning ? " [long-running]" : ""}`,
			);
		}
	}

	const subs = organ.subscriptions;
	if (subs.motor.length > 0 || subs.sense.length > 0) {
		const motorCount = subs.motor.length;
		const senseCount = subs.sense.length;
		lines.push(`  subscriptions: ${motorCount} motor, ${senseCount} sense`);
	}

	const contributions = organ.contributions;
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

	if (organ.directives?.length) {
		lines.push(`  directives: ${organ.directives.length} block(s), ${organ.directives.join("").length} chars`);
	}

	return lines.join("\n");
}
