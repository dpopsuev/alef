/**
 * XDG Base Directory paths for Alef user data.
 *
 * Spec: https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html
 *
 * Runtime stores (sessions, plans, forge, code-intel graph, cache) live under XDG.
 * Never write new state under `<cwd>/.alef/` or `~/.alef/`.
 * Path helpers read process.env at call time so XDG_* overrides work in tests.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CWD_HASH_LENGTH = 12;

/**
 *
 */
function envOr(name: string, fallback: string): string {
	const raw = process.env[name];
	if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
	return fallback;
}

/**
 *
 */
export function xdgConfigHome(): string {
	return envOr("XDG_CONFIG_HOME", join(homedir(), ".config"));
}

/**
 *
 */
export function xdgDataHome(): string {
	return envOr("XDG_DATA_HOME", join(homedir(), ".local/share"));
}

/**
 *
 */
export function xdgStateHome(): string {
	return envOr("XDG_STATE_HOME", join(homedir(), ".local/state"));
}

/**
 *
 */
export function xdgCacheHome(): string {
	return envOr("XDG_CACHE_HOME", join(homedir(), ".cache"));
}

/**
 *
 */
export function alefConfigDir(): string {
	return join(xdgConfigHome(), "alef");
}

/**
 *
 */
export function alefDataDir(): string {
	return join(xdgDataHome(), "alef");
}

/**
 *
 */
export function alefStateDir(): string {
	return join(xdgStateHome(), "alef");
}

/**
 *
 */
export function alefCacheDir(): string {
	return join(xdgCacheHome(), "alef");
}

/**
 *
 */
export function legacyAlefHome(): string {
	return join(homedir(), ".alef");
}

/**
 *
 */
export function userSkillsDir(): string {
	return join(alefConfigDir(), "skills");
}

/**
 *
 */
export function debugSkillPath(): string {
	return join(userSkillsDir(), "debug-alef", "SKILL.md");
}

/**
 *
 */
export function userThemePath(): string {
	return join(alefConfigDir(), "theme.yaml");
}

/**
 *
 */
export function userConfigPath(): string {
	return join(alefConfigDir(), "config.yaml");
}

/**
 *
 */
export function agentDir(): string {
	return join(alefConfigDir(), "agent");
}

/**
 *
 */
export function sessionsDir(): string {
	return join(alefDataDir(), "sessions");
}

/**
 *
 */
export function plansDir(): string {
	return join(alefDataDir(), "plans");
}

/**
 *
 */
export function prototypesDir(): string {
	return join(alefDataDir(), "prototypes");
}

/**
 *
 */
export function databasePath(): string {
	return join(alefDataDir(), "alef.db");
}

/**
 *
 */
export function telemetryDir(): string {
	return join(alefDataDir(), "telemetry");
}

/**
 *
 */
export function daemonPath(): string {
	return join(alefStateDir(), "daemon.json");
}

/**
 *
 */
export function lastSessionPath(): string {
	return join(alefStateDir(), "last-session.json");
}

/** $XDG_STATE_HOME/alef/last-model — last :model pick (survives process restart). */
export function lastModelPath(): string {
	return join(alefStateDir(), "last-model");
}

/**
 *
 */
export function debugLogPath(): string {
	return join(alefStateDir(), "debug.log");
}

/**
 *
 */
export function lspCacheDir(): string {
	return join(alefCacheDir(), "lsp");
}

/**
 *
 */
export function embeddingsCacheDir(): string {
	return join(alefCacheDir(), "embeddings");
}

/** Stable short hash of an absolute cwd for per-workspace XDG subdirs. */
export function cwdHash(cwd: string): string {
	return createHash("sha1").update(cwd).digest("hex").slice(0, CWD_HASH_LENGTH);
}

/** $XDG_DATA_HOME/alef/forge/<cwd-hash> — local PR sidecar store. */
export function forgeDir(cwd: string): string {
	return join(alefDataDir(), "forge", cwdHash(cwd));
}

/** $XDG_CACHE_HOME/alef/code-intel/<cwd-hash> — regenerable code graph. */
export function codeIntelCacheDir(cwd: string): string {
	return join(alefCacheDir(), "code-intel", cwdHash(cwd));
}

/** Default SQLite path for the workspace code graph. */
export function codeIntelGraphDbPath(cwd: string): string {
	return join(codeIntelCacheDir(cwd), "graph.db");
}

/** Compat aliases — same as the camelCase helpers (call as `SESSIONS_DIR()`). */
export const ALEF_CONFIG_DIR = alefConfigDir;
export const ALEF_DATA_DIR = alefDataDir;
export const ALEF_STATE_DIR = alefStateDir;
export const ALEF_CACHE_DIR = alefCacheDir;
export const USER_SKILLS_DIR = userSkillsDir;
export const DEBUG_SKILL_PATH = debugSkillPath;
export const USER_THEME_PATH = userThemePath;
export const USER_CONFIG_PATH = userConfigPath;
export const AGENT_DIR = agentDir;
export const SESSIONS_DIR = sessionsDir;
export const PLANS_DIR = plansDir;
export const PROTOTYPES_DIR = prototypesDir;
export const DATABASE_PATH = databasePath;
export const TELEMETRY_DIR = telemetryDir;
export const DAEMON_PATH = daemonPath;
export const LAST_SESSION_PATH = lastSessionPath;
export const LAST_MODEL_PATH = lastModelPath;
export const DEBUG_LOG_PATH = debugLogPath;
export const LSP_CACHE_DIR = lspCacheDir;
export const EMBEDDINGS_CACHE_DIR = embeddingsCacheDir;
export const FORGE_DIR = forgeDir;
export const CODE_INTEL_CACHE_DIR = codeIntelCacheDir;
export const CODE_INTEL_GRAPH_DB_PATH = codeIntelGraphDbPath;
export const CWD_HASH = cwdHash;
export const XDG_CONFIG_HOME = xdgConfigHome;
export const XDG_DATA_HOME = xdgDataHome;
export const XDG_STATE_HOME = xdgStateHome;
export const XDG_CACHE_HOME = xdgCacheHome;

/** Project-local agentskills.io directory (`<cwd>/.agents`). */
export function projectAgentsDir(cwd: string): string {
	return join(cwd, ".agents");
}

/** Project-local directive markdown files. */
export function projectDirectivesDir(cwd: string): string {
	return join(projectAgentsDir(cwd), "directives");
}

/** Project-local SKILL.md library. */
export function projectSkillsDir(cwd: string): string {
	return join(projectAgentsDir(cwd), "skills");
}

/**
 * Prefer XDG agent dir; fall back to legacy ~/.alef/agent when present and XDG is empty.
 * ALEF_CODING_AGENT_DIR always wins.
 */
export function resolveAgentDir(): string {
	const envDir = process.env.ALEF_CODING_AGENT_DIR?.trim();
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return join(homedir(), envDir.slice(2));
		return envDir;
	}
	const xdg = agentDir();
	const legacy = join(legacyAlefHome(), "agent");
	if (existsSync(xdg)) return xdg;
	if (existsSync(legacy)) return legacy;
	return xdg;
}

type MigrateEntry = { from: string; to: string };

/**
 *
 */
function migrateEntries(): MigrateEntry[] {
	const legacy = legacyAlefHome();
	return [
		{ from: join(legacy, "alef.db"), to: databasePath() },
		{ from: join(legacy, "alef.db-wal"), to: `${databasePath()}-wal` },
		{ from: join(legacy, "alef.db-shm"), to: `${databasePath()}-shm` },
		{ from: join(legacy, "sessions"), to: sessionsDir() },
		{ from: join(legacy, "prototypes"), to: prototypesDir() },
		{ from: join(legacy, "plans"), to: plansDir() },
		{ from: join(legacy, "telemetry"), to: telemetryDir() },
		{ from: join(legacy, "debug.log"), to: debugLogPath() },
		{ from: join(legacy, "daemon.json"), to: daemonPath() },
		{ from: join(legacy, "last-session.json"), to: lastSessionPath() },
		{ from: join(legacy, "agent"), to: agentDir() },
		{ from: join(legacy, "generations"), to: join(alefDataDir(), "generations") },
	];
}

/**
 *
 */
function tryMove(from: string, to: string): "moved" | "skipped" | "failed" {
	if (!existsSync(from)) return "skipped";
	if (existsSync(to)) return "skipped";
	mkdirSync(dirname(to), { recursive: true });
	try {
		renameSync(from, to);
		return "moved";
	} catch {
		return "failed";
	}
}

/**
 * Move legacy ~/.alef entries into XDG locations when the destination is absent.
 * Idempotent. Does not delete ~/.alef when both sides already have data.
 */
export function migrateLegacyAlefHome(): { moved: string[]; skipped: string[]; failed: string[] } {
	const moved: string[] = [];
	const skipped: string[] = [];
	const failed: string[] = [];
	if (!existsSync(legacyAlefHome())) {
		return { moved, skipped, failed };
	}
	for (const entry of migrateEntries()) {
		const result = tryMove(entry.from, entry.to);
		if (result === "moved") moved.push(`${entry.from} -> ${entry.to}`);
		else if (result === "failed") failed.push(entry.from);
		else skipped.push(entry.from);
	}
	return { moved, skipped, failed };
}

/** Create XDG alef directories. Idempotent. */
export function ensureAlefDirectories(): void {
	for (const dir of [
		userSkillsDir(),
		agentDir(),
		sessionsDir(),
		plansDir(),
		prototypesDir(),
		telemetryDir(),
		alefStateDir(),
		lspCacheDir(),
		embeddingsCacheDir(),
		join(alefDataDir(), "forge"),
		join(alefCacheDir(), "code-intel"),
	]) {
		mkdirSync(dir, { recursive: true });
	}
}

/**
 * Migrate legacy ~/.alef into XDG when destinations are empty, then ensure dirs exist.
 * Call once at process startup. Migrate runs before mkdir so empty targets do not block moves.
 */
export function ensureAlefHome(): ReturnType<typeof migrateLegacyAlefHome> {
	const result = migrateLegacyAlefHome();
	ensureAlefDirectories();
	return result;
}

/** Session JSONL roots to scan (XDG first, then legacy if still present). */
export function sessionScanRoots(): string[] {
	const roots = [sessionsDir()];
	const legacy = join(legacyAlefHome(), "sessions");
	if (existsSync(legacy)) {
		try {
			if (statSync(legacy).isDirectory() && legacy !== sessionsDir()) roots.push(legacy);
		} catch {
			/* ignore */
		}
	}
	return roots;
}
