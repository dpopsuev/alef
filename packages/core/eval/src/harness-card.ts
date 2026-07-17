/**
 * HarnessCard — disclosure of the execution scaffold for an eval run.
 *
 * Binding Constraint / HARNESSCARD: scores without harness disclosure
 * misattribute gains to the model. This card travels with RunMetrics.
 */

import { createHash } from "node:crypto";

const HASH_HEX_LENGTH = 16;

/** Compaction / context strategies Alef exposes today. */
export type HarnessCompactionStrategy = "summarize" | "shake" | "attention" | "off" | string;

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
	writableRoots?: string[];
	sandbox?: boolean;
	scenarioTimeoutMs?: number;
	noiseSeeding?: boolean;
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
		writableRoots: card.writableRoots ?? [],
		sandbox: card.sandbox ?? null,
		scenarioTimeoutMs: card.scenarioTimeoutMs ?? null,
		noiseSeeding: card.noiseSeeding ?? null,
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
		...(input.writableRoots !== undefined && { writableRoots: [...input.writableRoots] }),
		...(input.sandbox !== undefined && { sandbox: input.sandbox }),
		...(input.scenarioTimeoutMs !== undefined && { scenarioTimeoutMs: input.scenarioTimeoutMs }),
		...(input.noiseSeeding !== undefined && { noiseSeeding: input.noiseSeeding }),
	};

	const merged = input.overrides
		? {
				...base,
				...input.overrides,
				adapters: filterDisclosureAdapters(input.overrides.adapters ?? base.adapters),
				tools: [...new Set(input.overrides.tools ?? base.tools)].sort(),
			}
		: base;

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
	];
	if (card.writableRoots?.length) lines.push(`  writableRoots: ${card.writableRoots.join(", ")}`);
	if (card.sandbox !== undefined) lines.push(`  sandbox: ${card.sandbox}`);
	if (card.scenarioTimeoutMs !== undefined) lines.push(`  scenarioTimeoutMs: ${card.scenarioTimeoutMs}`);
	if (card.noiseSeeding !== undefined) lines.push(`  noiseSeeding: ${card.noiseSeeding}`);
	lines.push(`  collectedAt: ${card.collectedAt}`);
	return lines.join("\n");
}
