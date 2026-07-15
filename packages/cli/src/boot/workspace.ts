import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Directives } from "@dpopsuev/alef-agent/directives";

/** Keep workspace rules in the system prompt without eating the cold-start budget. */
const AGENTS_MD_MAX_CHARS = 4_000;
const WORKSPACE_DIRECTIVE_MAX_CHARS = 2_000;

/** Load AGENTS.md and .alef/directives/*.md from the workspace into the directive set. */
export async function loadWorkspace(directives: Directives, cwd: string): Promise<void> {
	for (const name of ["AGENTS.md", "agents.md"]) {
		try {
			const content = (await readFile(join(cwd, name), "utf-8")).trim();
			if (content) {
				directives.register({
					id: "agents-md",
					priority: 450,
					content,
					enabled: true,
					tags: ["workspace", "agents-md"],
					maxChars: AGENTS_MD_MAX_CHARS,
				});
				break;
			}
		} catch {
			/* absent — continue */
		}
	}

	const dir = join(cwd, ".alef", "directives");
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	for (const file of entries.filter((e) => e.endsWith(".md")).sort()) {
		try {
			const content = (await readFile(join(dir, file), "utf-8")).trim();
			if (content) {
				directives.register({
					id: `workspace.${file}`,
					priority: 500,
					content,
					enabled: true,
					tags: ["workspace"],
					maxChars: WORKSPACE_DIRECTIVE_MAX_CHARS,
				});
			}
		} catch {
			// skip unreadable files
		}
	}
}
