/**
 * SKILL.md discovery — implements the agentskills.io standard.
 * https://agentskills.io
 *
 * Standard search paths (checked in order, deduped):
 *   1. $ALEF_SKILLS_DIR (env override)
 *   2. $XDG_CONFIG_HOME/agents/skills  or  ~/.config/agents/skills
 *   3. $XDG_CONFIG_HOME/alef/skills    or  ~/.config/alef/skills
 *   4. ~/.agents/skills
 *   5. .agents/skills  (relative to cwd)
 *   6. .alef/skills    (relative to cwd)
 *   7. .claude/skills  (relative to cwd — cross-agent compat)
 *   8. Additional paths from adapter options
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Skill, SkillFrontmatter } from "./types.js";

const SKILL_FILENAME = "SKILL.md";

/**
 *
 */
function xdgConfig(): string {
	return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

/**
 *
 */
export function standardSkillPaths(cwd: string): string[] {
	const dirs: string[] = [];
	if (process.env.ALEF_SKILLS_DIR) dirs.push(process.env.ALEF_SKILLS_DIR);
	dirs.push(
		join(xdgConfig(), "agents", "skills"),
		join(xdgConfig(), "alef", "skills"),
		join(homedir(), ".agents", "skills"),
		join(cwd, ".agents", "skills"),
		join(cwd, ".alef", "skills"),
		join(cwd, ".claude", "skills"),
	);
	return [...new Set(dirs)];
}

/**
 *
 */
function parseSkillMd(filePath: string, content: string): Skill | null {
	// YAML frontmatter between --- delimiters.
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return null;
	const [, frontmatterRaw, instructions] = match;
	try {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- parseYaml returns unknown; shape validated by the guard below
		const fm = parseYaml(frontmatterRaw!) as SkillFrontmatter;
		if (!fm.name || !fm.description) return null;
		return {
			name: fm.name,
			description: fm.description,
			userInvocable: fm["user-invocable"] ?? false,
			disableModelInvocation: fm["disable-model-invocation"] ?? false,
			instructions: instructions!.trim(),
			path: filePath,
		};
	} catch {
		return null;
	}
}

/**
 *
 */
function scanDir(dir: string): Skill[] {
	if (!existsSync(dir)) return [];
	const skills: Skill[] = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && entry.name === SKILL_FILENAME) {
				const filePath = join(dir, SKILL_FILENAME);
				const content = readFileSync(filePath, "utf-8");
				const skill = parseSkillMd(filePath, content);
				if (skill) skills.push(skill);
			} else if (entry.isDirectory()) {
				const nested = join(dir, entry.name, SKILL_FILENAME);
				if (existsSync(nested)) {
					const content = readFileSync(nested, "utf-8");
					const skill = parseSkillMd(nested, content);
					if (skill) skills.push(skill);
				}
			}
		}
	} catch {
		// Permission errors etc — skip silently.
	}
	return skills;
}

/**
 *
 */
export function discoverSkills(cwd: string, extraPaths: string[] = []): Skill[] {
	const allPaths = [...standardSkillPaths(cwd), ...extraPaths.map((p) => resolve(cwd, p))];
	const seen = new Set<string>();
	const skills: Skill[] = [];
	for (const dir of allPaths) {
		for (const skill of scanDir(dir)) {
			if (!seen.has(skill.path)) {
				seen.add(skill.path);
				skills.push(skill);
			}
		}
	}
	return skills;
}

/**
 * Format active skills as an index for system prompt injection.
 *
 * Progressive disclosure (agentskills.io standard, Hermes pattern):
 *   Level 0 — index only: name + description (~3 tokens per skill)
 *   Level 1 — full body: loaded on demand via skills.invoke
 *
 * Injecting full instruction bodies at mount time wastes context budget
 * for every session regardless of whether any skill is relevant.
 */
export function skillsToXml(skills: Skill[]): string {
	if (skills.length === 0) return "";
	const items = skills
		.filter((s) => !s.disableModelInvocation)
		.map((s) => `<skill name="${s.name}" description="${s.description}" />`)
		.join("\n");
	return items ? `<skills>\n${items}\n</skills>` : "";
}
