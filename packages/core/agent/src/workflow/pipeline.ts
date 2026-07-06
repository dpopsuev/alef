// eslint-disable-next-line no-restricted-imports -- workflow types belong in core; refactor pending
import type { StationResult, StationRunner, WorkflowDef } from "@dpopsuev/alef-tool-workflow";

/**
 *
 */
export interface PipelineResult {
	stations: Record<string, StationResult>;
	final: StationResult | undefined;
}

/**
 *
 */
export async function runPipeline(
	def: WorkflowDef,
	runner: StationRunner,
	initialArtifact?: unknown,
): Promise<PipelineResult> {
	const results: Record<string, StationResult> = {};
	let currentName = def.start;
	let artifact: unknown = initialArtifact;

	while (currentName !== def.done) {
		const stationDef = def.stations.find((s) => s.name === currentName);
		if (!stationDef) break;

		const result = await runner.run(stationDef, artifact);
		results[currentName] = result;

		if (result.status !== "fulfilled") break;

		artifact = result.output;

		const edge = def.edges.find((e) => e.from === currentName && (!e.when || evalCondition(e.when, artifact)));
		if (!edge) break;

		currentName = edge.to;
	}

	const final = results[Object.keys(results).at(-1) ?? ""];
	return { stations: results, final };
}

/**
 *
 */
function evalCondition(when: string, artifact: unknown): boolean {
	if (!when) return true;
	if (typeof artifact !== "object" || artifact === null) return true;
	const [lhs, op, rhs] = when.split(/\s*(==|!=)\s*/);
	if (!lhs || !op) return true;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed from object via typeof guard above
	const artifactValue = (artifact as Record<string, unknown>)[lhs.trim()];
	const value = typeof artifactValue === "string" ? artifactValue : "";
	const expected = rhs.trim().replace(/^"|"$/g, "");
	return op === "==" ? value === expected : value !== expected;
}
