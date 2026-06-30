import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ColorToken, ThemeTokens } from "./theme.js";
import { BUILT_IN_THEMES, buildTerminalTheme, setTheme, setThemeByName } from "./theme.js";

interface ThemeManifest {
	theme?: string;
	colors?: Partial<Record<keyof ThemeTokens, string>>;
}

function loadManifest(path: string): ThemeManifest | null {
	try {
		const raw = readFileSync(path, "utf-8");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- YAML config shape is well-known
		return parseYaml(raw) as ThemeManifest;
	} catch {
		return null;
	}
}

function hexToken(hex: string): ColorToken {
	return { truecolor: hex };
}

export function loadTheme(
	blueprintDir?: string,
	cfgThemeName?: string,
	cfgColors?: Record<string, string>,
	isDark = true,
	/** Terminal palette from OSC 4 queries — used to enrich the terminal theme with real colors. */
	terminalPalette: Record<number, string> = {},
): void {
	// Priority: blueprint agent.yaml > ~/.config/alef/theme.yaml > config.yaml theme section
	const candidates = [
		blueprintDir ? join(blueprintDir, "agent.yaml") : null,
		join(homedir(), ".config", "alef", "theme.yaml"),
	].filter((p): p is string => p !== null);

	let manifest: ThemeManifest | null = null;
	for (const path of candidates) {
		manifest = loadManifest(path);
		if (manifest) break;
	}

	// Default is 'terminal' for dark terminals, 'terminal-light' for light terminals.
	// OSC 11 detection in detectDark() already ran before this call.
	const defaultTheme = isDark ? "terminal" : "terminal-light";
	const baseName = manifest?.theme ?? cfgThemeName ?? defaultTheme;

	if ((baseName === "terminal" || baseName === "terminal-light") && Object.keys(terminalPalette).length > 0) {
		setTheme(buildTerminalTheme(terminalPalette));
	} else {
		setThemeByName(baseName);
	}

	const allColors: Record<string, string> = { ...cfgColors, ...manifest?.colors };
	if (Object.keys(allColors).length === 0) return;

	const base = BUILT_IN_THEMES[baseName.toLowerCase()] ?? BUILT_IN_THEMES.terminal;
	const overrides: Partial<Record<keyof ThemeTokens, ColorToken>> = {};
	for (const [k, v] of Object.entries(allColors)) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- user config keys mapped to ThemeTokens; unknown keys are harmless
		if (typeof v === "string") overrides[k as keyof ThemeTokens] = hexToken(v);
	}

	setTheme({ ...base, ...overrides });
}
