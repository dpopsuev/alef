import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveXdgConfigHome(): string {
	const raw = process.env.XDG_CONFIG_HOME;
	if (typeof raw === "string" && raw.trim() !== "") {
		return raw.trim();
	}
	return join(homedir(), ".config");
}

function expandTildePath(dir: string): string {
	if (dir === "~") return homedir();
	if (dir.startsWith("~/")) return homedir() + dir.slice(1);
	return dir;
}

/** Matches packages/coding-agent/src/config.ts getAgentDir() for logging paths. */
export function resolveAlfAgentDir(): string {
	const envDir = process.env.ALF_CODING_AGENT_DIR;
	if (envDir?.trim()) {
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
