import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { blueprintRegistry } from "@dpopsuev/alef-agent-blueprint";
import { runPicker } from "./run-picker.js";

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

function readBlueprintPreview(path: string): string[] {
	try {
		const raw = readFileSync(path, "utf-8");
		const lines: string[] = [];

		const descMatch = raw.match(/^description:\s*>?\s*\n([\s\S]*?)(?=\n\w)/m);
		if (descMatch) {
			const desc = descMatch[1]
				.trim()
				.split("\n")
				.map((l) => l.trim())
				.join(" ");
			lines.push(`  ${desc}`);
			lines.push("");
		}

		const organMatches = [...raw.matchAll(/^\s+-\s+name:\s*(\S+)/gm)];
		if (organMatches.length > 0) {
			lines.push("  Organs (SBOM):");
			for (const m of organMatches) {
				const organName = m[1];
				const pkgMatch = raw.match(new RegExp(`name:\\s*${organName}[\\s\\S]*?package:\\s*"?([^"\\n]+)"?`));
				const pkg = pkgMatch?.[1] ?? `organ-${organName}`;
				lines.push(`    ${organName.padEnd(14)} ${pkg}`);
			}
			lines.push("");
		}

		const modelMatch = raw.match(/^model:\s*(.+)$/m);
		if (modelMatch) lines.push(`  Model: ${modelMatch[1].trim()}`);

		const capMatch = raw.match(/orchestration:\s*(true|false)/);
		if (capMatch) lines.push(`  Orchestration: ${capMatch[1]}`);

		const memMatch = raw.match(/session:\s*(\S+)/);
		if (memMatch) lines.push(`  Memory: ${memMatch[1]}`);

		const blockedMatches = [...raw.matchAll(/^\s+-\s+"(.+)"/gm)];
		if (blockedMatches.length > 0) {
			lines.push("");
			lines.push("  Blocked patterns:");
			for (const m of blockedMatches.slice(0, 5)) {
				lines.push(`    ${m[1]}`);
			}
		}

		return lines.length > 0 ? lines : ["  (no details available)"];
	} catch {
		return ["  (unable to read blueprint)"];
	}
}

export function resolveBlueprint(nameOrPath: string, cwd: string): string | undefined {
	const registeredNames = blueprintRegistry.list();
	if (registeredNames.includes(nameOrPath)) {
		return nameOrPath;
	}
	if (existsSync(nameOrPath)) return resolve(nameOrPath);
	const discovered = discoverBlueprints(cwd);
	const match = discovered.find((bp) => bp.name === nameOrPath);
	return match?.path;
}

export async function pickBlueprint(choices: BlueprintChoice[]): Promise<BlueprintChoice | undefined> {
	if (choices.length <= 1) return choices[0];

	const previewCache = new Map<string, string[]>();

	const result = await runPicker({
		title: "Blueprint",
		items: choices.map((bp) => ({
			value: bp.path,
			label: bp.name,
			description: bp.description.slice(0, 60),
		})),
		maxVisible: 10,
		previewFn: (item) => {
			if (!item) return [];
			const cached = previewCache.get(item.value);
			if (cached) return cached;
			const preview = readBlueprintPreview(item.value);
			previewCache.set(item.value, preview);
			return preview;
		},
	});

	if (!result) return choices[0];
	return choices.find((c) => c.path === result.value);
}
