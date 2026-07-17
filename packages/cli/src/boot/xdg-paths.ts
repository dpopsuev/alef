/**
 * XDG paths for the CLI — re-exports the canonical kernel module.
 *
 * Spec: https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html
 *
 * Directory structure:
 *   $XDG_CONFIG_HOME/alef/          → User-specific configuration
 *   $XDG_DATA_HOME/alef/            → User-specific data (sessions, db, prototypes)
 *   $XDG_STATE_HOME/alef/           → Runtime state (daemon, last-session, debug.log)
 *   $XDG_CACHE_HOME/alef/           → Non-essential cache (LSP, embeddings, code-intel graph)
 *
 * Historical ALL_CAPS exports are zero-arg functions (call `SESSIONS_DIR()`).
 */

export {
	AGENT_DIR,
	ALEF_CACHE_DIR,
	ALEF_CONFIG_DIR,
	ALEF_DATA_DIR,
	ALEF_STATE_DIR,
	agentDir,
	alefCacheDir,
	alefConfigDir,
	alefDataDir,
	alefStateDir,
	CODE_INTEL_CACHE_DIR,
	CODE_INTEL_GRAPH_DB_PATH,
	CWD_HASH,
	codeIntelCacheDir,
	codeIntelGraphDbPath,
	cwdHash,
	DAEMON_PATH,
	DATABASE_PATH,
	DEBUG_LOG_PATH,
	DEBUG_SKILL_PATH,
	daemonPath,
	databasePath,
	debugLogPath,
	debugSkillPath,
	EMBEDDINGS_CACHE_DIR,
	embeddingsCacheDir,
	ensureAlefDirectories,
	ensureAlefHome,
	FORGE_DIR,
	forgeDir,
	LAST_SESSION_PATH,
	LSP_CACHE_DIR,
	lastSessionPath,
	legacyAlefHome,
	lspCacheDir,
	migrateLegacyAlefHome,
	PLANS_DIR,
	PROTOTYPES_DIR,
	plansDir,
	projectAgentsDir,
	projectDirectivesDir,
	projectSkillsDir,
	prototypesDir,
	resolveAgentDir,
	SESSIONS_DIR,
	sessionScanRoots,
	sessionsDir,
	TELEMETRY_DIR,
	telemetryDir,
	USER_CONFIG_PATH,
	USER_SKILLS_DIR,
	USER_THEME_PATH,
	userConfigPath,
	userSkillsDir,
	userThemePath,
	XDG_CACHE_HOME,
	XDG_CONFIG_HOME,
	XDG_DATA_HOME,
	XDG_STATE_HOME,
	xdgCacheHome,
	xdgConfigHome,
	xdgDataHome,
	xdgStateHome,
} from "@dpopsuev/alef-kernel/xdg";

import { ensureAlefHome } from "@dpopsuev/alef-kernel/xdg";

/** Ensure XDG dirs exist and migrate legacy ~/.alef when destinations are empty. */
export function ensureDirectories(): void {
	ensureAlefHome();
}
