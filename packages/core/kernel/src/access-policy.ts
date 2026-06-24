import { resolve } from "node:path";

export interface AccessDecision {
	action: "allow" | "deny" | "escalate";
	reason?: string;
}

export interface AccessPolicy {
	check(toolName: string, payload: Record<string, unknown>): AccessDecision;
}

export interface AccessPolicyRules {
	paths?: {
		allow?: readonly string[];
		deny?: readonly RegExp[];
		escalate?: readonly RegExp[];
	};
	commands?: {
		deny?: readonly RegExp[];
		escalate?: readonly RegExp[];
	};
	urls?: {
		deny?: readonly RegExp[];
		escalate?: readonly RegExp[];
	};
}

const CREDENTIAL_PATH_PATTERNS: RegExp[] = [
	/[/\\]\.ssh[/\\]/i,
	/[/\\]\.gnupg[/\\]/i,
	/[/\\]\.aws[/\\]/i,
	/[/\\]\.azure[/\\]/i,
	/\.env$/i,
	/\.env\./i,
	/[/\\]\.config[/\\]alef[/\\]/i,
];

const CREDENTIAL_ENV_PATTERNS: RegExp[] = [
	/api[_-]?key/i,
	/auth[_-]?token/i,
	/secret/i,
	/password/i,
	/private[_-]?key/i,
	/access[_-]?token/i,
	/bearer/i,
];

const SSRF_URL_PATTERNS: RegExp[] = [
	/^https?:\/\/localhost/i,
	/^https?:\/\/127\.0\.0\.1/i,
	/^https?:\/\/\[::1\]/i,
	/^https?:\/\/169\.254\./i,
	/^https?:\/\/metadata\.google\.internal/i,
];

const PATH_FIELDS = ["path", "glob", "pattern", "oldPath", "newPath"];

function extractPaths(payload: Record<string, unknown>): string[] {
	const paths: string[] = [];
	for (const field of PATH_FIELDS) {
		const v = payload[field];
		if (typeof v === "string" && v.length > 0) paths.push(v);
	}
	return paths;
}

function matchesAny(value: string, patterns: readonly RegExp[]): RegExp | undefined {
	return patterns.find((p) => p.test(value));
}

function isWithinRoots(absPath: string, roots: readonly string[]): boolean {
	const norm = resolve(absPath);
	return roots.some((root) => {
		const normRoot = resolve(root);
		return norm === normRoot || norm.startsWith(`${normRoot}/`);
	});
}

export const ALLOW_ALL: AccessPolicy = {
	check: () => ({ action: "allow" }),
};

export function createAccessPolicy(rules: AccessPolicyRules): AccessPolicy {
	const pathDeny = [...CREDENTIAL_PATH_PATTERNS, ...(rules.paths?.deny ?? [])];
	const pathEscalate = rules.paths?.escalate ?? [];
	const pathAllow = rules.paths?.allow;

	const cmdDeny = [...CREDENTIAL_ENV_PATTERNS, ...(rules.commands?.deny ?? [])];
	const cmdEscalate = rules.commands?.escalate ?? [];

	const urlDeny = [...SSRF_URL_PATTERNS, ...(rules.urls?.deny ?? [])];
	const urlEscalate = rules.urls?.escalate ?? [];

	return {
		check(toolName: string, payload: Record<string, unknown>): AccessDecision {
			if (toolName.startsWith("fs.") || toolName.startsWith("lector.")) {
				const paths = extractPaths(payload);
				for (const p of paths) {
					const denyMatch = matchesAny(p, pathDeny);
					if (denyMatch) return { action: "deny", reason: `Path denied: ${p}` };

					const escMatch = matchesAny(p, pathEscalate);
					if (escMatch) return { action: "escalate", reason: `Path requires approval: ${p}` };

					if (pathAllow && !isWithinRoots(p, pathAllow)) {
						return { action: "deny", reason: `Path outside allowed roots: ${p}` };
					}
				}
			}

			if (toolName.startsWith("shell.")) {
				const command = typeof payload.command === "string" ? payload.command : "";
				if (command) {
					const denyMatch = matchesAny(command, cmdDeny);
					if (denyMatch) return { action: "deny", reason: "Command denied by security policy" };

					const escMatch = matchesAny(command, cmdEscalate);
					if (escMatch)
						return { action: "escalate", reason: `Command requires approval: ${command.slice(0, 80)}` };
				}
			}

			if (toolName.startsWith("web.")) {
				const url = typeof payload.url === "string" ? payload.url : "";
				if (url) {
					const denyMatch = matchesAny(url, urlDeny);
					if (denyMatch) return { action: "deny", reason: `URL denied (SSRF prevention): ${url}` };

					const escMatch = matchesAny(url, urlEscalate);
					if (escMatch) return { action: "escalate", reason: `URL requires approval: ${url}` };
				}
			}

			return { action: "allow" };
		},
	};
}
