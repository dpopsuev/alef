import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = join(fileURLToPath(import.meta.url), "..", "prompts");

const cache = new Map<string, string>();

export function loadPrompt(name: string, vars?: Record<string, string>): string {
	let text = cache.get(name);
	if (!text) {
		const path = join(PROMPTS_DIR, `${name}.md`);
		text = readFileSync(path, "utf-8").trim();
		cache.set(name, text);
	}
	if (vars) {
		for (const [key, value] of Object.entries(vars)) {
			text = text.replaceAll(`{{${key}}}`, value);
		}
	}
	return text;
}

export function listPromptTemplates(): string[] {
	try {
		return readdirSync(PROMPTS_DIR)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.replace(".md", ""));
	} catch {
		return [];
	}
}
