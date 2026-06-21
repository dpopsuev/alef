import { type Api, getModels, getProviders, type KnownProvider, type Model } from "@dpopsuev/alef-llm";
import type { AlefConfig } from "./config.js";

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

export function resolveProfile(cfg: AlefConfig): ResolvedProfile | null {
	const profileName = cfg.profile;
	if (!profileName || !cfg.profiles?.[profileName]) return null;

	const profile = cfg.profiles[profileName];
	const models: ResolvedProfile["models"] = [];

	for (const provider of profile.providers) {
		if (!getProviders().includes(provider as KnownProvider)) continue;
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

export function getProfileNames(cfg: AlefConfig): string[] {
	return cfg.profiles ? Object.keys(cfg.profiles) : [];
}
