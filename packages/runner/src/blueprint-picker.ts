import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { blueprintRegistry } from "@dpopsuev/alef-agent-blueprint";
import { ProcessTerminal, type SelectItem, SelectList, Text, TUI } from "@dpopsuev/alef-tui";
import { bold, color, getTheme } from "./theme.js";

export interface BlueprintChoice {
	name: string;
	description: string;
	path: string;
}

export function discoverBlueprints(cwd: string): BlueprintChoice[] {
	const choices: BlueprintChoice[] = [];
	const seen = new Set<string>();

	const localDirs = [join(cwd, ".alef/blueprints"), join(cwd, "blueprints")];
	const globalDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "alef", "blueprints");

	for (const dir of [...localDirs, globalDir]) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			const path = resolve(dir, entry.name);
			const meta = readBlueprintMeta(path);
			if (meta && !seen.has(meta.name)) {
				seen.add(meta.name);
				choices.push({ name: meta.name, description: meta.description, path });
			}
		}
	}

	const monorepoBlueprintsDir = findMonorepoBlueprintPackages(cwd);
	for (const bp of monorepoBlueprintsDir) {
		if (!seen.has(bp.name)) {
			seen.add(bp.name);
			choices.push(bp);
		}
	}

	return choices;
}

function findMonorepoBlueprintPackages(cwd: string): BlueprintChoice[] {
	const packagesDir = findPackagesDir(cwd);
	if (!packagesDir) return [];

	const results: BlueprintChoice[] = [];
	for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("alef-")) continue;
		const blueprintPath = join(packagesDir, entry.name, "blueprint.yaml");
		if (existsSync(blueprintPath)) {
			const meta = readBlueprintMeta(blueprintPath);
			if (meta) results.push({ name: meta.name, description: meta.description, path: blueprintPath });
		}
	}
	return results;
}

function findPackagesDir(from: string): string | undefined {
	let dir = from;
	for (let i = 0; i < 5; i++) {
		const candidate = join(dir, "packages");
		if (existsSync(candidate)) return candidate;
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

function readBlueprintMeta(path: string): { name: string; description: string } | undefined {
	try {
		const raw = readFileSync(path, "utf-8");
		const nameMatch = raw.match(/^name:\s*(.+)$/m);
		const descMatch = raw.match(/^description:\s*>?\s*\n?\s*(.+)$/m);
		if (!nameMatch) return undefined;
		return {
			name: nameMatch[1].trim(),
			description: descMatch?.[1]?.trim() ?? "",
		};
	} catch {
		return undefined;
	}
}

export function resolveBlueprint(nameOrPath: string, cwd: string): string | undefined {
	// First check if it's a registered blueprint name (e.g., YAML blueprints from ~/.config/alef/agents)
	const registeredNames = blueprintRegistry.list();
	if (registeredNames.includes(nameOrPath)) {
		// Return the name itself - it will be resolved from the registry later
		return nameOrPath;
	}

	// Then check if it's an existing file path
	if (existsSync(nameOrPath)) return resolve(nameOrPath);

	// Finally check discovered blueprints from filesystem
	const discovered = discoverBlueprints(cwd);
	const match = discovered.find((bp) => bp.name === nameOrPath);
	return match?.path;
}

export async function pickBlueprint(choices: BlueprintChoice[]): Promise<BlueprintChoice | undefined> {
	if (choices.length <= 1) return choices[0];

	const t = getTheme();

	const items: SelectItem[] = choices.map((bp) => ({
		value: bp.path,
		label: bp.name,
		description: bp.description.slice(0, 60),
	}));

	const listTheme = {
		selectedPrefix: (s: string) => color(s, t.accentFg),
		selectedText: (s: string) => bold(s),
		description: (s: string) => color(s, t.mutedFg),
		scrollInfo: (s: string) => color(s, t.mutedFg),
		noMatch: (s: string) => color(s, t.mutedFg),
	};

	return new Promise<BlueprintChoice | undefined>((res) => {
		const terminal = new ProcessTerminal();
		const tui = new TUI(terminal);

		tui.addChild(new Text(color("  Blueprint — ↑↓ navigate  Enter select", t.mutedFg), 0, 0));
		tui.addChild(new Text("", 0, 0));

		const list = new SelectList(items, 8, listTheme);
		list.onSelect = (item) => {
			tui.stop();
			res(choices.find((c) => c.path === item.value));
		};

		tui.addChild(list);

		tui.onRawInput = (data) => {
			if (data === "\x1b") {
				tui.stop();
				res(choices[0]);
				return true;
			}
			if (data === "\x1b[A" || data === "\x1b[B" || data === "\r" || data === "\n") {
				list.handleInput(data);
			}
			tui.requestRender();
			return true;
		};

		tui.start();
		tui.requestRender();
	});
}
