import { getModels, getProviders } from "@dpopsuev/alef-llm";
function matchesPattern(id, patterns) {
    return patterns.some((p) => {
        if (p.includes("*")) {
            const re = new RegExp(`^${p.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
            return re.test(id);
        }
        return id === p;
    });
}
export function resolveProfile(cfg) {
    const profileName = cfg.profile;
    if (!profileName || !cfg.profiles?.[profileName])
        return null;
    const profile = cfg.profiles[profileName];
    const models = [];
    for (const provider of profile.providers ?? []) {
        if (!getProviders().includes(provider))
            continue;
        for (const m of getModels(provider)) {
            if (profile.models && !matchesPattern(m.id, profile.models))
                continue;
            models.push({ provider, model: m });
        }
    }
    return {
        name: profileName,
        models,
        defaultModel: profile.default,
    };
}
export function getProfileNames(cfg) {
    return cfg.profiles ? Object.keys(cfg.profiles) : [];
}
export function resolveTier(cfg, tier) {
    const profileName = cfg.profile;
    if (!profileName || !cfg.profiles?.[profileName])
        return undefined;
    const profile = cfg.profiles[profileName];
    return profile.tiers?.[tier] ?? profile.default;
}
//# sourceMappingURL=profiles.js.map