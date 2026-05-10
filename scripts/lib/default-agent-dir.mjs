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

/** Mirrors packages/coding-agent/src/config.ts getAgentDir(). */
export function getDefaultAgentDir() {
	const envDir = process.env.ALF_CODING_AGENT_DIR;
	if (envDir) {
		return expandTildePath(envDir.trim());
	}
	if (process.platform === "linux") {
		const xdgAgentDir = join(resolveXdgConfigHome(), "alf", "agent");
		const legacyAgentDir = join(homedir(), ".alf", "agent");
		if (existsSync(legacyAgentDir)) {
			return legacyAgentDir;
		}
		return xdgAgentDir;
	}
	return join(homedir(), ".alf", "agent");
}
