import { getModels, getProviders } from "@dpopsuev/alef-llm/models";
import type { Api, KnownProvider, Model } from "@dpopsuev/alef-llm/types";
import type { ModelConfig } from "./resolve.js";

export interface ModelProfile {
	name: string;
	providers: string[];
	modelPatterns?: string[];
	defaultModel?: string;
}

export interface ResolvedProfile {
	name: string;
	models: Array<{ provider: string; model: Model<Api> }>;
	defaultModel?: string;
}

function matchesPattern(id: string, patterns: string[]): boolean {
	return patterns.some((p) => {
		if (p.includes("*")) {
			const re = new RegExp(`^${p.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
			return re.test(id);
		}
		return id === p;
	});
}

export function resolveProfile(cfg: ModelConfig): ResolvedProfile | null {
	const profileName = cfg.profile;
	if (!profileName || !cfg.profiles?.[profileName]) return null;

	const profile = cfg.profiles[profileName];
	const models: ResolvedProfile["models"] = [];

	for (const provider of profile.providers ?? []) {
		if (!(getProviders() as readonly string[]).includes(provider)) continue;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by includes() above
		for (const m of getModels(provider as KnownProvider)) {
			if (profile.models && !matchesPattern(m.id, profile.models)) continue;
			models.push({ provider, model: m });
		}
	}

	return {
		name: profileName,
		models,
		defaultModel: profile.default,
	};
}

export function getProfileNames(cfg: ModelConfig): string[] {
	return cfg.profiles ? Object.keys(cfg.profiles) : [];
}

export type ModelTier = "strong" | "default" | "fast";

export function resolveTier(cfg: ModelConfig, tier: ModelTier): string | undefined {
	const profileName = cfg.profile;
	if (!profileName || !cfg.profiles?.[profileName]) return undefined;
	const profile = cfg.profiles[profileName];
	return profile.tiers?.[tier] ?? profile.default;
}
