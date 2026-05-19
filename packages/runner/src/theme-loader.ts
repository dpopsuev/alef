import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ColorToken, ThemeTokens } from "./theme.js";
import { BUILT_IN_THEMES, setTheme, setThemeByName } from "./theme.js";

interface ThemeManifest {
	theme?: string;
	colors?: Partial<Record<keyof ThemeTokens, string>>;
}

function loadManifest(path: string): ThemeManifest | null {
	try {
		const raw = readFileSync(path, "utf-8");
		return parseYaml(raw) as ThemeManifest;
	} catch {
		return null;
	}
}

function hexToken(hex: string): ColorToken {
	return { truecolor: hex };
}

/**
 * Load theme from ~/.config/alef/theme.yaml or the blueprint's agent.yaml.
 * Merges color overrides on top of the named built-in.
 */
export function loadTheme(blueprintDir?: string): void {
	const candidates = [
		join(homedir(), ".config", "alef", "theme.yaml"),
		blueprintDir ? join(blueprintDir, "agent.yaml") : null,
	].filter(Boolean) as string[];

	let manifest: ThemeManifest | null = null;
	for (const path of candidates) {
		manifest = loadManifest(path);
		if (manifest) break;
	}

	if (!manifest) return;

	const baseName = manifest.theme ?? "akko";
	setThemeByName(baseName);

	if (!manifest.colors) return;

	const base = BUILT_IN_THEMES[baseName.toLowerCase()] ?? BUILT_IN_THEMES.akko;
	const overrides: Partial<Record<keyof ThemeTokens, ColorToken>> = {};
	for (const [k, v] of Object.entries(manifest.colors)) {
		if (typeof v === "string") overrides[k as keyof ThemeTokens] = hexToken(v);
	}

	setTheme({ ...base, ...overrides });
}
