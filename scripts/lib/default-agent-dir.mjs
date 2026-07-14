import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveXdgConfigHome() {
	const raw = process.env.XDG_CONFIG_HOME;
	if (typeof raw === "string" && raw.trim() !== "") {
		return raw.trim();
	}
	return join(homedir(), ".config");
}

export function expandTildePath(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return homedir() + path.slice(1);
	return path;
}

/** Mirrors @dpopsuev/alef-kernel/xdg resolveAgentDir(). */
export function getDefaultAgentDir() {
	const envDir = process.env.ALEF_CODING_AGENT_DIR;
	if (envDir) {
		return expandTildePath(envDir.trim());
	}
	const xdgAgentDir = join(resolveXdgConfigHome(), "alef", "agent");
	const legacyAgentDir = join(homedir(), ".alef", "agent");
	if (existsSync(xdgAgentDir)) return xdgAgentDir;
	if (existsSync(legacyAgentDir)) return legacyAgentDir;
	return xdgAgentDir;
}
