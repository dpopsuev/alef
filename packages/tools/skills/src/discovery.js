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
 *   6. .claude/skills  (relative to cwd — cross-agent compat)
 *   7. Additional paths from adapter options
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { projectSkillsDir, userSkillsDir, xdgConfigHome } from "@dpopsuev/alef-kernel/xdg";
import { parse as parseYaml } from "yaml";
const SKILL_FILENAME = "SKILL.md";
export function standardSkillPaths(cwd) {
    const dirs = [];
    if (process.env.ALEF_SKILLS_DIR)
        dirs.push(process.env.ALEF_SKILLS_DIR);
    dirs.push(join(xdgConfigHome(), "agents", "skills"), userSkillsDir(), join(homedir(), ".agents", "skills"), projectSkillsDir(cwd), join(cwd, ".claude", "skills"));
    return [...new Set(dirs)];
}
function parseSkillMd(filePath, content) {
    // YAML frontmatter between --- delimiters.
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match)
        return null;
    const [, frontmatterRaw, instructions] = match;
    try {
        const fm = parseYaml(frontmatterRaw ?? "");
        if (!fm?.name || !fm?.description)
            return null;
        return {
            name: fm.name,
            description: fm.description,
            userInvocable: fm["user-invocable"] ?? false,
            disableModelInvocation: fm["disable-model-invocation"] ?? false,
            instructions: instructions.trim(),
            path: filePath,
        };
    }
    catch {
        return null;
    }
}
function scanDir(dir) {
    if (!existsSync(dir))
        return [];
    const skills = [];
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile() && entry.name === SKILL_FILENAME) {
                const filePath = join(dir, SKILL_FILENAME);
                const content = readFileSync(filePath, "utf-8");
                const skill = parseSkillMd(filePath, content);
                if (skill)
                    skills.push(skill);
            }
            else if (entry.isDirectory()) {
                const nested = join(dir, entry.name, SKILL_FILENAME);
                if (existsSync(nested)) {
                    const content = readFileSync(nested, "utf-8");
                    const skill = parseSkillMd(nested, content);
                    if (skill)
                        skills.push(skill);
                }
            }
        }
    }
    catch {
        // Permission errors etc — skip silently.
    }
    return skills;
}
export function discoverSkills(cwd, extraPaths = []) {
    const allPaths = [...standardSkillPaths(cwd), ...extraPaths.map((p) => resolve(cwd, p))];
    const seen = new Set();
    const skills = [];
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
export function skillsToXml(skills) {
    if (skills.length === 0)
        return "";
    const items = skills
        .filter((s) => !s.disableModelInvocation)
        .map((s) => `<skill name="${s.name}" description="${s.description}" />`)
        .join("\n");
    return items ? `<skills>\n${items}\n</skills>` : "";
}
