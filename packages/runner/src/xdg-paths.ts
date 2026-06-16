/**
 * XDG Base Directory Specification paths for Alef.
 *
 * Spec: https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html
 *
 * Directory structure:
 *   $XDG_CONFIG_HOME/alef/          → User-specific configuration
 *     ├── theme.yaml                → Custom TUI theme
 *     ├── config.yaml               → User preferences
 *     └── skills/                   → User skill library
 *         ├── debug-alef/SKILL.md   → Debug diagnostics skill
 *         └── custom-skill/SKILL.md → User-defined skills
 *
 *   $XDG_DATA_HOME/alef/            → User-specific data
 *     ├── sessions/<cwd-hash>/      → Session JSONL logs
 *     │   ├── <session-id>.jsonl
 *     │   └── latest
 *     └── prototypes/               → User-written organ prototypes
 *         └── <name>.ts
 *
 *   $XDG_STATE_HOME/alef/           → Logs, history, runtime state
 *     ├── debug.log                 → Pino debug trace (rotates at 10MB)
 *     ├── daemon.json               → Daemon registry (port, pid, session)
 *     └── last-session.json         → Most recent session metadata
 *
 *   $XDG_CACHE_HOME/alef/           → Non-essential cache data
 *     ├── lsp/                      → TypeScript LSP cache
 *     └── embeddings/               → Vector embedding cache
 *
 *   <cwd>/.alef/                    → Project-local configuration
 *     ├── directives/               → Project-specific system prompts
 *     └── skills/                   → Project-specific skills
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** XDG_CONFIG_HOME — user-specific configuration files (default: ~/.config) */
export const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");

/** XDG_DATA_HOME — user-specific data files (default: ~/.local/share) */
export const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share");

/** XDG_STATE_HOME — user-specific state data (logs, history) (default: ~/.local/state) */
export const XDG_STATE_HOME = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");

/** XDG_CACHE_HOME — user-specific non-essential cache (default: ~/.cache) */
export const XDG_CACHE_HOME = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");

/** Alef configuration directory ($XDG_CONFIG_HOME/alef) */
export const ALEF_CONFIG_DIR = join(XDG_CONFIG_HOME, "alef");

/** Alef data directory ($XDG_DATA_HOME/alef) */
export const ALEF_DATA_DIR = join(XDG_DATA_HOME, "alef");

/** Alef state directory ($XDG_STATE_HOME/alef) */
export const ALEF_STATE_DIR = join(XDG_STATE_HOME, "alef");

/** Alef cache directory ($XDG_CACHE_HOME/alef) */
export const ALEF_CACHE_DIR = join(XDG_CACHE_HOME, "alef");

/**
 * Legacy ~/.alef path — used for backward compatibility.
 * New installations should use XDG paths.
 */
export const LEGACY_ALEF_DIR = join(homedir(), ".alef");

// ---------------------------------------------------------------------------
// Specific paths
// ---------------------------------------------------------------------------

/** User skills directory ($XDG_CONFIG_HOME/alef/skills) */
export const USER_SKILLS_DIR = join(ALEF_CONFIG_DIR, "skills");

/** Debug skill path ($XDG_CONFIG_HOME/alef/skills/debug-alef/SKILL.md) */
export const DEBUG_SKILL_PATH = join(USER_SKILLS_DIR, "debug-alef", "SKILL.md");

/** User theme file ($XDG_CONFIG_HOME/alef/theme.yaml) */
export const USER_THEME_PATH = join(ALEF_CONFIG_DIR, "theme.yaml");

/** User config file ($XDG_CONFIG_HOME/alef/config.yaml) */
export const USER_CONFIG_PATH = join(ALEF_CONFIG_DIR, "config.yaml");

/** Session storage root ($XDG_DATA_HOME/alef/sessions) */
export const SESSIONS_DIR = join(ALEF_DATA_DIR, "sessions");

/** Prototypes directory ($XDG_DATA_HOME/alef/prototypes) */
export const PROTOTYPES_DIR = join(ALEF_DATA_DIR, "prototypes");

/** Debug log file ($XDG_STATE_HOME/alef/debug.log) */
export const DEBUG_LOG_PATH = join(ALEF_STATE_DIR, "debug.log");

/** Daemon registry ($XDG_STATE_HOME/alef/daemon.json) */
export const DAEMON_PATH = join(ALEF_STATE_DIR, "daemon.json");

/** Last session metadata ($XDG_STATE_HOME/alef/last-session.json) */
export const LAST_SESSION_PATH = join(ALEF_STATE_DIR, "last-session.json");

/** LSP cache directory ($XDG_CACHE_HOME/alef/lsp) */
export const LSP_CACHE_DIR = join(ALEF_CACHE_DIR, "lsp");

/** Embeddings cache directory ($XDG_CACHE_HOME/alef/embeddings) */
export const EMBEDDINGS_CACHE_DIR = join(ALEF_CACHE_DIR, "embeddings");

/**
 * Get project-local .alef directory (relative to cwd).
 * Used for project-specific directives and skills.
 */
export function getProjectAlefDir(cwd: string): string {
	return join(cwd, ".alef");
}

/**
 * Ensure all XDG directories exist. Called once at process startup.
 * Idempotent — mkdir -p is a no-op for existing directories.
 */
export function ensureDirectories(): void {
	for (const dir of [
		join(ALEF_CONFIG_DIR, "skills"),
		join(ALEF_DATA_DIR, "sessions"),
		join(ALEF_DATA_DIR, "prototypes"),
		ALEF_STATE_DIR,
		LSP_CACHE_DIR,
		EMBEDDINGS_CACHE_DIR,
	]) {
		mkdirSync(dir, { recursive: true });
	}
}
