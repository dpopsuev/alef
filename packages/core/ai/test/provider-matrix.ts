/**
 * Collapses the "one describe.skipIf block per provider" copy-paste pattern
 * (dozens of near-identical blocks per file, repeated across ~15 test files)
 * into a data table plus a single generator. Behavior is unchanged: every
 * case still goes through the same HAVE_REAL_LLM opt-in gate and the same
 * per-provider credential check as the hand-written blocks it replaces.
 */

import type { TestContext } from "vitest";
import { describe, it } from "vitest";
import type { Api, Model } from "../src/types.js";
import { HAVE_REAL_LLM } from "./gate.js";

/** One provider's worth of test wiring: how to build its model, its credential gate, and any extra options. */
export interface ProviderCase<TApi extends Api = Api> {
	/** describe/it label, e.g. "Google Provider" or "GitHub Copilot (OAuth) - gpt-5-mini". */
	name: string;
	/** Whether this provider's credentials are configured. Evaluated eagerly at matrix-definition time. */
	hasCredentials: boolean;
	/** Resolves the model lazily, inside the test body — after the credential check, so api-override models
	 * (e.g. forcing "openai-completions" onto a base "openai" model) and OAuth-token models are built fresh
	 * per run rather than once at module scope. */
	model: () => Model<TApi> | undefined;
	/** Extra per-provider options merged into the test call (apiKey, reasoningEffort, thinking, ...).
	 * A function form is available for options that depend on the resolved model (e.g. Azure deployment
	 * name lookup, which needs `llm.id`). */
	options?: Record<string, unknown> | ((llm: Model<TApi>) => Record<string, unknown>);
	/** Skip this specific case even when credentials are present (known upstream limitation). The reason
	 * is folded into the test title so `it.skip` output stays self-explanatory. */
	skipReason?: string;
	/** Skip only specific scenarios (by title) for this case, keeping the rest active — e.g. a provider
	 * that handles one scenario fine but has a known limitation on another. */
	scenarioSkipReasons?: Record<string, string>;
}

/** One test scenario applied to every provider case (e.g. "emoji in tool results", "unpaired surrogate"). */
export interface ProviderScenario<TApi extends Api = Api> {
	title: string;
	run: (ctx: TestContext, llm: Model<TApi>, options: Record<string, unknown>) => Promise<void>;
}

type AlefTestTag = "unit" | "compliance" | "integration" | "e2e" | "real-llm" | "canary" | "benchmark";

export interface DescribeProvidersOptions {
	retry?: number;
	timeout?: number;
	tags?: AlefTestTag[];
}

function resolveOptions<TApi extends Api>(
	options: ProviderCase<TApi>["options"],
	llm: Model<TApi>,
): Record<string, unknown> {
	if (typeof options === "function") return options(llm);
	return options ?? {};
}

/**
 * Generates `describe.skipIf(!HAVE_REAL_LLM)(title) { describe.skipIf(!hasCredentials)(case.name) { it(scenario.title) } }`
 * for every case x scenario pair. `scenarios` is always an explicit list — even a single-test provider block
 * passes a one-element array — so the describe title and the it() title never get conflated.
 */
export function describeProviders<TApi extends Api>(
	title: string,
	cases: readonly ProviderCase<TApi>[],
	scenarios: readonly ProviderScenario<TApi>[],
	opts: DescribeProvidersOptions = {},
): void {
	const { retry = 3, timeout = 30000, tags = ["integration"] } = opts;

	describe.skipIf(!HAVE_REAL_LLM)(title, { tags }, () => {
		for (const c of cases) {
			describe.skipIf(!c.hasCredentials)(c.name, () => {
				for (const scenario of scenarios) {
					const reason = c.skipReason ?? c.scenarioSkipReasons?.[scenario.title];
					const runner = reason ? it.skip : it;
					const scenarioTitle = reason ? `${scenario.title} (skipped: ${reason})` : scenario.title;
					runner(scenarioTitle, { retry, timeout }, async (ctx) => {
						const llm = c.model();
						if (!llm) throw new Error(`describeProviders: model not found for "${c.name}"`);
						await scenario.run(ctx, llm, resolveOptions(c.options, llm));
					});
				}
			});
		}
	});
}
