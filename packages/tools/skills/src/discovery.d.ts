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
import type { Skill } from "./types.js";
export declare function standardSkillPaths(cwd: string): string[];
export declare function discoverSkills(cwd: string, extraPaths?: string[]): Skill[];
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
export declare function skillsToXml(skills: Skill[]): string;
//# sourceMappingURL=discovery.d.ts.map