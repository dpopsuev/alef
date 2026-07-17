/**
 * HarnessCard — disclosure of the execution scaffold for an eval run.
 *
 * Binding Constraint / HARNESSCARD: scores without harness disclosure
 * misattribute gains to the model. This card travels with RunMetrics.
 *
 * ETCSOVG fields: Environment/Tools/Compaction via top-level; Execution +
 * Governance nested for sandbox, roots, budgets, approvals, lifecycle intercepts.
 */

import { createHash } from "node:crypto";

const HASH_HEX_LENGTH = 16;

/** Compaction / context strategies Alef exposes today. */
export type HarnessCompactionStrategy = "summarize" | "shake" | "attention" | "off" | string;

/** Execution enclosure disclosure (sandbox, FS roots, budgets). */
export interface HarnessExecution {
	sandbox: boolean;
	writableRoots: string[];
	networkPolicy: "deny" | "allow" | "workspace";
	scenarioTimeoutMs?: number;
	maxSteps?: number;
}

/** Governance / lifecycle intercept disclosure. */
export interface HarnessGovernance {
	approvalMode: "none" | "dangerous" | "all";
	sideEffectBoundary: string;
	/** Binding-chain / reasoner intercept surfaces (Meng L). */
	lifecycleIntercepts: string[];
}

/** Default lifecycle intercepts Alef always has on the eval path. */
export const DEFAULT_LIFECYCLE_INTERCEPTS = [
	"binding.chain",
	"budget",
	"stall",
	"tool.wake",
	"context.assemble",
	"context.overflow-recovery",
] as const;

/** Structured harness disclosure (schemaVersion bumps on breaking field changes). */
export interface HarnessCard {
	schemaVersion: 1;
	/** ISO timestamp when the card was collected. */
	collectedAt: string;
	/** Stable hash of disclosure fields (excludes collectedAt). */
	fingerprint: string;
	model: string;
	provider?: string;
	contextWindow?: number;
	/** Blueprint / stack name (e.g. coding). */
	blueprint?: string;
	/** Loaded adapter names (excluding eval-only hosts when filtered). */
	adapters: string[];
	/** Tool names exposed to the model when known. */
	tools: string[];
	compactionStrategy: HarnessCompactionStrategy;
	toolDisclosure: string;
	attentionPinRecentTurns?: number;
	/** @deprecated Prefer execution.writableRoots */
	writableRoots?: string[];
	/** @deprecated Prefer execution.sandbox */
	sandbox?: boolean;
	scenarioTimeoutMs?: number;
	noiseSeeding?: boolean;
	execution: HarnessExecution;
	governance: HarnessGovernance;
}

/** Optional overrides / known values when collecting a card. */
export interface CollectHarnessCardInput {
	model?: string;
	provider?: string;
	contextWindow?: number;
	blueprint?: string;
	adapters?: readonly string[];
	tools?: readonly string[];
	compactionStrategy?: HarnessCompactionStrategy;
	toolDisclosure?: string;
	attentionPinRecentTurns?: number;
	writableRoots?: readonly string[];
	sandbox?: boolean;
	scenarioTimeoutMs?: number;
	noiseSeeding?: boolean;
	networkPolicy?: HarnessExecution["networkPolicy"];
	maxSteps?: number;
	approvalMode?: HarnessGovernance["approvalMode"];
	sideEffectBoundary?: string;
	lifecycleIntercepts?: readonly string[];
	/** Merge last — overrides any computed field except schemaVersion/fingerprint/collectedAt. */
	overrides?: Partial<Omit<HarnessCard, "schemaVersion" | "fingerprint" | "collectedAt">>;
}

const EVAL_ONLY_ADAPTERS = new Set(["evaluator", "judging"]);

/** Read compaction strategy from env (same contract as coding blueprint). */
export function resolveCompactionStrategy(
	raw: string | undefined = process.env.ALEF_COMPACTION_STRATEGY,
): HarnessCompactionStrategy {
	if (raw === "shake" || raw === "off" || raw === "summarize" || raw === "attention") return raw;
	return "summarize";
}

/** Drop eval-host adapters from disclosure lists. */
export function filterDisclosureAdapters(names: readonly string[]): string[] {
	return [...new Set(names.filter((name) => !EVAL_ONLY_ADAPTERS.has(name)))].sort();
}

/** Build Execution enclosure fields from collector input. */
function buildExecution(input: CollectHarnessCardInput, mergedRoots: string[], sandbox: boolean): HarnessExecution {
	return {
		sandbox,
		writableRoots: mergedRoots,
		networkPolicy: input.networkPolicy ?? "workspace",
		...(input.scenarioTimeoutMs !== undefined && { scenarioTimeoutMs: input.scenarioTimeoutMs }),
		...(input.maxSteps !== undefined && { maxSteps: input.maxSteps }),
	};
}

/** Build Governance / lifecycle intercept fields from collector input. */
function buildGovernance(input: CollectHarnessCardInput): HarnessGovernance {
	return {
		approvalMode: input.approvalMode ?? "none",
		sideEffectBoundary: input.sideEffectBoundary ?? "writableRoots",
		lifecycleIntercepts: [...(input.lifecycleIntercepts ?? DEFAULT_LIFECYCLE_INTERCEPTS)],
	};
}

/** Stable fingerprint over disclosure fields (not collectedAt). */
export function harnessCardFingerprint(
	card: Omit<HarnessCard, "fingerprint" | "collectedAt" | "schemaVersion"> & { schemaVersion: 1 },
): string {
	const payload = {
		schemaVersion: card.schemaVersion,
		model: card.model,
		provider: card.provider ?? "",
		contextWindow: card.contextWindow ?? null,
		blueprint: card.blueprint ?? "",
		adapters: card.adapters,
		tools: card.tools,
		compactionStrategy: card.compactionStrategy,
		toolDisclosure: card.toolDisclosure,
		attentionPinRecentTurns: card.attentionPinRecentTurns ?? null,
		writableRoots: card.execution.writableRoots,
		sandbox: card.execution.sandbox,
		scenarioTimeoutMs: card.execution.scenarioTimeoutMs ?? card.scenarioTimeoutMs ?? null,
		noiseSeeding: card.noiseSeeding ?? null,
		execution: card.execution,
		governance: card.governance,
	};
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, HASH_HEX_LENGTH);
}

/** Build a HarnessCard from env + caller-supplied runtime facts. */
export function collectHarnessCard(input: CollectHarnessCardInput = {}): HarnessCard {
	const pinRaw = process.env.ALEF_ATTENTION_PIN_RECENT;
	const pinParsed = pinRaw !== undefined ? Number(pinRaw) : undefined;
	const attentionPinRecentTurns =
		input.attentionPinRecentTurns ??
		(typeof pinParsed === "number" && Number.isFinite(pinParsed) ? pinParsed : undefined);

	const sandbox = input.sandbox ?? true;
	const writableRoots = [...(input.writableRoots ?? [])];
	const execution = buildExecution(input, writableRoots, sandbox);
	const governance = buildGovernance(input);

	const base: Omit<HarnessCard, "fingerprint" | "collectedAt"> = {
		schemaVersion: 1,
		model: input.model ?? process.env.ALEF_EVAL_MODEL ?? "(unknown)",
		...(input.provider !== undefined && { provider: input.provider }),
		...(input.contextWindow !== undefined && { contextWindow: input.contextWindow }),
		...(input.blueprint !== undefined && { blueprint: input.blueprint }),
		adapters: filterDisclosureAdapters(input.adapters ?? []),
		tools: [...new Set(input.tools ?? [])].sort(),
		compactionStrategy: input.compactionStrategy ?? resolveCompactionStrategy(),
		toolDisclosure: input.toolDisclosure ?? process.env.ALEF_TOOL_DISCLOSURE ?? "full",
		...(attentionPinRecentTurns !== undefined && { attentionPinRecentTurns }),
		writableRoots: execution.writableRoots,
		sandbox: execution.sandbox,
		...(input.scenarioTimeoutMs !== undefined && { scenarioTimeoutMs: input.scenarioTimeoutMs }),
		...(input.noiseSeeding !== undefined && { noiseSeeding: input.noiseSeeding }),
		execution,
		governance,
	};

	const merged = input.overrides
		? {
				...base,
				...input.overrides,
				adapters: filterDisclosureAdapters(input.overrides.adapters ?? base.adapters),
				tools: [...new Set(input.overrides.tools ?? base.tools)].sort(),
				execution: {
					...base.execution,
					...input.overrides.execution,
					writableRoots: [
						...(input.overrides.execution?.writableRoots ??
							input.overrides.writableRoots ??
							base.execution.writableRoots),
					],
					sandbox: input.overrides.execution?.sandbox ?? input.overrides.sandbox ?? base.execution.sandbox,
				},
				governance: {
					...base.governance,
					...input.overrides.governance,
					lifecycleIntercepts: [
						...(input.overrides.governance?.lifecycleIntercepts ?? base.governance.lifecycleIntercepts),
					],
				},
			}
		: base;

	// Keep legacy mirrors aligned with execution.
	merged.writableRoots = merged.execution.writableRoots;
	merged.sandbox = merged.execution.sandbox;

	const fingerprint = harnessCardFingerprint(merged);
	return {
		...merged,
		fingerprint,
		collectedAt: new Date().toISOString(),
	};
}

/** One-line summary for suite banners. */
export function formatHarnessCardLine(card: HarnessCard): string {
	const parts = [
		`fp=${card.fingerprint}`,
		`model=${card.model}`,
		card.blueprint ? `blueprint=${card.blueprint}` : undefined,
		`compaction=${card.compactionStrategy}`,
		`disclosure=${card.toolDisclosure}`,
		`sandbox=${card.execution.sandbox}`,
		card.adapters.length > 0 ? `adapters=${card.adapters.length}` : undefined,
	];
	return parts.filter(Boolean).join(" ");
}

/** Multi-line human-readable card. */
export function formatHarnessCard(card: HarnessCard): string {
	const lines = [
		`HarnessCard v${card.schemaVersion}  fingerprint=${card.fingerprint}`,
		`  model: ${card.model}${card.provider ? ` (${card.provider})` : ""}${card.contextWindow ? `  window=${card.contextWindow}` : ""}`,
		`  blueprint: ${card.blueprint ?? "(none)"}`,
		`  compaction: ${card.compactionStrategy}${card.attentionPinRecentTurns !== undefined ? `  attentionPin=${card.attentionPinRecentTurns}` : ""}`,
		`  toolDisclosure: ${card.toolDisclosure}`,
		`  adapters: ${card.adapters.length > 0 ? card.adapters.join(", ") : "(none)"}`,
		`  tools: ${card.tools.length > 0 ? card.tools.join(", ") : "(none)"}`,
		`  execution: sandbox=${card.execution.sandbox} network=${card.execution.networkPolicy} roots=[${card.execution.writableRoots.join(", ")}]`,
	];
	if (card.execution.scenarioTimeoutMs !== undefined) {
		lines.push(`           scenarioTimeoutMs=${card.execution.scenarioTimeoutMs}`);
	}
	if (card.execution.maxSteps !== undefined) {
		lines.push(`           maxSteps=${card.execution.maxSteps}`);
	}
	lines.push(
		`  governance: approvals=${card.governance.approvalMode} boundary=${card.governance.sideEffectBoundary}`,
		`              intercepts=${card.governance.lifecycleIntercepts.join(", ")}`,
	);
	if (card.noiseSeeding !== undefined) lines.push(`  noiseSeeding: ${card.noiseSeeding}`);
	lines.push(`  collectedAt: ${card.collectedAt}`);
	return lines.join("\n");
}
