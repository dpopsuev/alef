/**
 * Preflight — fast Blueprint + adapter config validation before eval.
 *
 * Four phases in ~2 seconds:
 *   1. validate   — blueprint has adapters, adapter names resolve, no duplicates
 *   2. components — each adapter mounts cleanly on a throw-away Bus
 *   3. tools      — every ToolDefinition has a valid Zod inputSchema
 *   4. probe      — one Command event per adapter per tool, Event event returns
 *
 * Returns PreflightReport { passed, warnings, errors } — structured, not just Error.
 * Mediator connectivity emits a warning not an error (degraded not broken).
 *
 * Mirrors Tako calibrate.Preflight.
 */

import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { type AgentBus, InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { runAdapterContract } from "@dpopsuev/alef-testkit";

/** Configuration for the preflight adapter validation run. */
export interface PreflightConfig {
	/** Adapters to validate. At least one required. */
	adapters: Adapter[];
	/** Timeout per Command→Event probe in ms. Default: 2000. */
	probeTimeoutMs?: number;
	/** Bus factory. Default: new InProcessBus(). */
	busFactory?: () => AgentBus;
}

/** A single error found during preflight validation. */
export interface PreflightError {
	phase: "validate" | "components" | "tools" | "probe";
	adapter?: string;
	tool?: string;
	detail: string;
}

/** Structured result of a preflight validation run. */
export interface PreflightReport {
	passed: string[];
	warnings: string[];
	errors: PreflightError[];
	/** Wall-clock duration of the preflight run in ms. */
	elapsedMs: number;
	ok: boolean;
}

/**
 * Run preflight validation on a set of adapters.
 * Returns a structured report. Does not throw.
 */
export async function preflight(cfg: PreflightConfig): Promise<PreflightReport> {
	const start = Date.now();
	const passed: string[] = [];
	const warnings: string[] = [];
	const errors: PreflightError[] = [];
	// eslint-disable-next-line no-magic-numbers
	const timeoutMs = cfg.probeTimeoutMs ?? 2000;

	const ok = (phase: string) => passed.push(phase);
	const warn = (msg: string) => warnings.push(msg);
	const fail = (error: PreflightError) => errors.push(error);

	// Phase 1: validate — adapters array non-empty, names non-empty, no duplicates
	if (cfg.adapters.length === 0) {
		fail({ phase: "validate", detail: "adapters array is empty — nothing to validate" });
		return { passed, warnings, errors, elapsedMs: Date.now() - start, ok: false };
	}

	const seenNames = new Set<string>();
	for (const adapter of cfg.adapters) {
		if (!adapter.name || adapter.name.trim() === "") {
			fail({ phase: "validate", detail: "adapter has empty name" });
		} else if (seenNames.has(adapter.name)) {
			fail({ phase: "validate", adapter: adapter.name, detail: `duplicate adapter name "${adapter.name}"` });
		} else {
			seenNames.add(adapter.name);
		}
	}

	if (errors.length === 0) {
		ok("validate");
	}

	// Phase 2: components — each adapter mounts without throwing
	for (const adapter of cfg.adapters) {
		try {
			const bus = cfg.busFactory ? cfg.busFactory() : new InProcessBus();
			const unmount = adapter.mount(bus.asBus());
			if (typeof unmount !== "function") {
				fail({
					phase: "components",
					adapter: adapter.name,
					detail: `mount() returned ${typeof unmount}, expected function`,
				});
			} else {
				unmount();
			}
		} catch (e) {
			fail({ phase: "components", adapter: adapter.name, detail: `mount() threw: ${String(e)}` });
		}
	}

	if (!errors.some((e) => e.phase === "components")) {
		ok("components");
	}

	// Phase 3: tools — every ToolDefinition has a parseable inputSchema
	for (const adapter of cfg.adapters) {
		for (const tool of adapter.tools) {
			try {
				// safeParse with empty object — we just want to know the schema is functional
				tool.inputSchema.safeParse({});
			} catch (e) {
				fail({
					phase: "tools",
					adapter: adapter.name,
					tool: tool.name,
					detail: `inputSchema.safeParse threw: ${String(e)}`,
				});
			}
		}
	}

	if (!errors.some((e) => e.phase === "tools")) {
		ok("tools");
	}

	// Phase 4: probe — RunAdapterContract on each adapter (Command→Event round-trip)
	for (const adapter of cfg.adapters) {
		if (adapter.tools.length === 0) {
			warn(`adapter "${adapter.name}" has no tools — skipping probe`);
			continue;
		}
		const report = await runAdapterContract(adapter, { timeoutMs });
		for (const v of report.violations) {
			if (v.check.startsWith("probe-")) {
				fail({ phase: "probe", adapter: adapter.name, detail: `${v.check}: ${v.detail}` });
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
