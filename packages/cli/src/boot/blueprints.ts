import { existsSync, readFileSync } from "node:fs";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";
import { runPicker } from "../client/commands/picker.js";

export interface BlueprintChoice {
	name: string;
	description: string;
	path: string;
}

export function discoverBlueprints(): BlueprintChoice[] {
	return blueprintRegistry.list().map((name) => ({ name, description: "", path: name }));
}

export function resolveBlueprint(nameOrPath: string, _cwd?: string): string | undefined {
	if (blueprintRegistry.list().includes(nameOrPath)) return nameOrPath;
	if (existsSync(nameOrPath)) return nameOrPath;
	return undefined;
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

		const adapterMatches = [...raw.matchAll(/^\s+-\s+name:\s*(\S+)/gm)];
		if (adapterMatches.length > 0) {
			lines.push("  Adapters (SBOM):");
			for (const m of adapterMatches) {
				const adapterName = m[1];
				const pkgMatch = raw.match(new RegExp(`name:\\s*${adapterName}[\\s\\S]*?package:\\s*"?([^"\\n]+)"?`));
				const pkg = pkgMatch?.[1] ?? `adapter-${adapterName}`;
				const ADAPTER_NAME_COL_WIDTH = 14;
				lines.push(`    ${adapterName.padEnd(ADAPTER_NAME_COL_WIDTH)} ${pkg}`);
			}
			lines.push("");
		}

		const modelMatch = raw.match(/^model:\s*(.+)$/m);
		if (modelMatch) lines.push(`  Model: ${modelMatch[1].trim()}`);

		const capMatch = raw.match(/orchestration:\s*(true|false)/);
		if (capMatch) lines.push(`  Orchestration: ${capMatch[1]}`);

		return lines.length > 0 ? lines : ["  (no details available)"];
	} catch {
		return ["  (unable to read blueprint)"];
	}
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
