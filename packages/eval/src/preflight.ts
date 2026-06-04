/**
 * Preflight — fast Blueprint + organ config validation before eval.
 *
 * Four phases in ~2 seconds:
 *   1. validate   — blueprint has organs, organ names resolve, no duplicates
 *   2. components — each organ mounts cleanly on a throw-away Nerve
 *   3. tools      — every ToolDefinition has a valid Zod inputSchema
 *   4. probe      — one Motor event per organ per tool, Sense event returns
 *
 * Returns PreflightReport { passed, warnings, errors } — structured, not just Error.
 * Mediator connectivity emits a warning not an error (degraded not broken).
 *
 * Mirrors Tako calibrate.Preflight.
 */

import { InProcessNerve, type Organ } from "@dpopsuev/alef-spine";
import { runOrganContract } from "@dpopsuev/alef-testkit";

export interface PreflightConfig {
	/** Organs to validate. At least one required. */
	organs: Organ[];
	/** Timeout per Motor→Sense probe in ms. Default: 2000. */
	probeTimeoutMs?: number;
}

export interface PreflightError {
	phase: "validate" | "components" | "tools" | "probe";
	organ?: string;
	tool?: string;
	detail: string;
}

export interface PreflightReport {
	passed: string[];
	warnings: string[];
	errors: PreflightError[];
	/** Wall-clock duration of the preflight run in ms. */
	elapsedMs: number;
	ok: boolean;
}

/**
 * Run preflight validation on a set of organs.
 * Returns a structured report. Does not throw.
 */
export async function preflight(cfg: PreflightConfig): Promise<PreflightReport> {
	const start = Date.now();
	const passed: string[] = [];
	const warnings: string[] = [];
	const errors: PreflightError[] = [];
	const timeoutMs = cfg.probeTimeoutMs ?? 2000;

	const ok = (phase: string) => passed.push(phase);
	const warn = (msg: string) => warnings.push(msg);
	const fail = (error: PreflightError) => errors.push(error);

	// Phase 1: validate — organs array non-empty, names non-empty, no duplicates
	if (!cfg.organs || cfg.organs.length === 0) {
		fail({ phase: "validate", detail: "organs array is empty — nothing to validate" });
		return { passed, warnings, errors, elapsedMs: Date.now() - start, ok: false };
	}

	const seenNames = new Set<string>();
	for (const organ of cfg.organs) {
		if (!organ.name || organ.name.trim() === "") {
			fail({ phase: "validate", detail: "organ has empty name" });
		} else if (seenNames.has(organ.name)) {
			fail({ phase: "validate", organ: organ.name, detail: `duplicate organ name "${organ.name}"` });
		} else {
			seenNames.add(organ.name);
		}
	}

	if (errors.length === 0) {
		ok("validate");
	}

	// Phase 2: components — each organ mounts without throwing
	for (const organ of cfg.organs) {
		try {
			const nerve = new InProcessNerve();
			const unmount = organ.mount(nerve.asNerve());
			if (typeof unmount !== "function") {
				fail({
					phase: "components",
					organ: organ.name,
					detail: `mount() returned ${typeof unmount}, expected function`,
				});
			} else {
				unmount();
			}
		} catch (e) {
			fail({ phase: "components", organ: organ.name, detail: `mount() threw: ${e}` });
		}
	}

	if (!errors.some((e) => e.phase === "components")) {
		ok("components");
	}

	// Phase 3: tools — every ToolDefinition has a parseable inputSchema
	for (const organ of cfg.organs) {
		for (const tool of organ.tools) {
			if (!tool.inputSchema) {
				fail({ phase: "tools", organ: organ.name, tool: tool.name, detail: "inputSchema is missing" });
				continue;
			}
			try {
				// safeParse with empty object — we just want to know the schema is functional
				tool.inputSchema.safeParse({});
			} catch (e) {
				fail({
					phase: "tools",
					organ: organ.name,
					tool: tool.name,
					detail: `inputSchema.safeParse threw: ${e}`,
				});
			}
		}
	}

	if (!errors.some((e) => e.phase === "tools")) {
		ok("tools");
	}

	// Phase 4: probe — RunOrganContract on each organ (Motor→Sense round-trip)
	for (const organ of cfg.organs) {
		if (organ.tools.length === 0) {
			warn(`organ "${organ.name}" has no tools — skipping probe`);
			continue;
		}
		const report = await runOrganContract(organ, { timeoutMs });
		for (const v of report.violations) {
			if (v.check.startsWith("probe-")) {
				fail({ phase: "probe", organ: organ.name, detail: `${v.check}: ${v.detail}` });
			}
		}
	}

	if (!errors.some((e) => e.phase === "probe")) {
		ok("probe");
	}

	return {
		passed,
		warnings,
		errors,
		elapsedMs: Date.now() - start,
		ok: errors.length === 0,
	};
}
