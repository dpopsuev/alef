import { resolve } from "node:path";
import type { Nerve, Organ, ToolDefinition, ValidateRequest } from "@dpopsuev/alef-kernel";
import { VALIDATE_REQUEST, VALIDATE_RESULT } from "@dpopsuev/alef-kernel";

/** Default credential path patterns — deny reads/writes to these locations. */
const DENY_PATH_PATTERNS: readonly RegExp[] = [
	/[/\\]\.config[/\\]alef[/\\]/i,
	/[/\\]\.ssh[/\\]/i,
	/[/\\]\.gnupg[/\\]/i,
	/[/\\]\.aws[/\\]/i,
	/[/\\]\.azure[/\\]/i,
	/\.env$/i,
	/\.env\./i,
];

/** Deny environment variable reads matching these patterns. */
const DENY_ENV_PATTERNS: readonly RegExp[] = [
	/api[_-]?key/i,
	/auth[_-]?token/i,
	/secret/i,
	/password/i,
	/private[_-]?key/i,
	/access[_-]?token/i,
	/bearer/i,
];

/** Tool name prefixes that carry path-based payloads to check. */
const PATH_TOOL_PREFIXES = ["fs.", "shell.", "lector."];

export interface SecurityPolicyOrganOptions {
	name?: string;
	extraDenyPaths?: RegExp[];
	extraDenyEnv?: RegExp[];
	/**
	 * OCAP grant — directories that are allowed.
	 * Undefined = unrestricted (no path scope enforcement).
	 * Populated = enforce that paths fall within these roots.
	 */
	writableRoots?: readonly string[];
}

function isDeniedPath(path: string, extras: RegExp[]): boolean {
	return [...DENY_PATH_PATTERNS, ...extras].some((r) => r.test(path));
}

function isDeniedEnvPattern(text: string, extras: RegExp[]): boolean {
	return [...DENY_ENV_PATTERNS, ...extras].some((r) => r.test(text));
}

function isWithinRoots(absPath: string, roots: readonly string[]): boolean {
	const norm = resolve(absPath);
	return roots.some((root) => {
		const normRoot = resolve(root);
		return norm === normRoot || norm.startsWith(`${normRoot}/`);
	});
}

function checkPayload(payload: Record<string, unknown>, opts: SecurityPolicyOrganOptions): string | null {
	const path = typeof payload.path === "string" ? payload.path : undefined;
	const command = typeof payload.command === "string" ? payload.command : undefined;
	const glob = typeof payload.glob === "string" ? payload.glob : undefined;

	if (path && isDeniedPath(path, opts.extraDenyPaths ?? [])) {
		return `Credential path denied: ${path}`;
	}
	if (glob && isDeniedPath(glob, opts.extraDenyPaths ?? [])) {
		return `Credential path denied: ${glob}`;
	}

	// OCAP scope enforcement: if writableRoots is set, check path is within them.
	if (path && opts.writableRoots) {
		const abs = resolve(path);
		if (!isWithinRoots(abs, opts.writableRoots)) {
			return `Path '${path}' is outside the allowed roots`;
		}
	}

	if (command) {
		const lc = command.toLowerCase();
		if (isDeniedPath(lc, opts.extraDenyPaths ?? [])) {
			return `Command targets credential path`;
		}
		if (isDeniedEnvPattern(lc, opts.extraDenyEnv ?? [])) {
			return `Command accesses credential environment variable`;
		}
	}
	return null;
}

export function createSecurityPolicyOrgan(opts: SecurityPolicyOrganOptions = {}): Organ {
	const organName = opts.name ?? "security-policy";

	return {
		name: organName,
		tools: [] as readonly ToolDefinition[],
		description: "Policy Enforcement Point — rejects tool calls targeting credential paths and enforces OCAP scope.",
		directives: [
			"Credential paths and environment variables are protected by security policy and cannot be accessed.",
		],
		subscriptions: {
			motor: [VALIDATE_REQUEST],
			sense: [] as readonly string[],
		},
		sources: [],
		mount(nerve: Nerve): () => void {
			return nerve.motor.subscribe(VALIDATE_REQUEST, (event) => {
				const req = event.payload as unknown as ValidateRequest;

				const targetOrgan = req.targetOrgan ?? "";
				const isPathOrgan = PATH_TOOL_PREFIXES.some((p) => targetOrgan.startsWith(p));
				if (!isPathOrgan) return;

				const payload = (req.output ?? {}) as Record<string, unknown>;
				const denial = checkPayload(payload, opts);

				if (denial) {
					nerve.sense.publish({
						type: VALIDATE_RESULT,
						correlationId: event.correlationId,
						payload: { id: req.id, approved: false, feedback: denial, reviewer: organName },
						isError: false,
					});
				} else {
					nerve.sense.publish({
						type: VALIDATE_RESULT,
						correlationId: event.correlationId,
						payload: { id: req.id, approved: true, reviewer: organName },
						isError: false,
					});
				}
			});
		},
	};
}
