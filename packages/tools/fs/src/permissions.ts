/**
 * Permission guard for filesystem operations.
 *
 * Evaluates declarative permission rules using glob matching with first-match-wins semantics.
 */

import { minimatch } from "minimatch";
import type { FilesystemOperation, FilesystemPermission } from "@dpopsuev/alef-kernel/adapter";

/**
 * Permission check result.
 */
export interface PermissionResult {
	/** Whether the operation is allowed. */
	allowed: boolean;
	/** The rule that matched, if any. */
	matchedRule?: FilesystemPermission;
	/** Human-readable reason for denial. */
	reason?: string;
}

/**
 * Guards filesystem operations using declarative permission rules.
 *
 * Evaluates rules in order; first matching rule determines the outcome.
 * If no rules match, access is denied by default.
 */
export class PermissionGuard {
	constructor(private readonly rules: FilesystemPermission[]) {}

	/**
	 * Check if an operation on a path is permitted.
	 *
	 * @param operation - The filesystem operation to check
	 * @param absolutePath - The absolute file path to check
	 * @returns Permission result with allow/deny decision
	 */
	check(operation: FilesystemOperation, absolutePath: string): PermissionResult {
		// First-match-wins evaluation
		for (const rule of this.rules) {
			// Skip rules that don't apply to this operation
			if (!rule.operations.includes(operation)) {
				continue;
			}

			// Check if any path pattern matches
			const pathMatches = rule.paths.some((pattern) => {
				return minimatch(absolutePath, pattern, {
					dot: true, // Match dotfiles
					matchBase: false, // Require full path match
				});
			});

			if (pathMatches) {
				const allowed = rule.mode === "allow";
				return {
					allowed,
					matchedRule: rule,
					reason: allowed
						? undefined
						: `Operation '${operation}' denied by rule: ${rule.paths.join(", ")} (mode: ${rule.mode})`,
				};
			}
		}

		// Default deny if no rules match
		return {
			allowed: false,
			reason: `No permission rule matched for operation '${operation}' on path '${absolutePath}'`,
		};
	}

	/**
	 * Assert that an operation is allowed, throwing if denied.
	 *
	 * @param operation - The filesystem operation to check
	 * @param absolutePath - The absolute file path to check
	 * @throws Error if the operation is denied
	 */
	assert(operation: FilesystemOperation, absolutePath: string): void {
		const result = this.check(operation, absolutePath);
		if (!result.allowed) {
			throw new Error(`Permission denied: ${result.reason}`);
		}
	}
}

/**
 * Create a permission guard from a list of rules, or return undefined if no rules provided.
 *
 * @param rules - Permission rules from blueprint schema
 * @returns PermissionGuard instance or undefined if rules array is empty
 */
export function createPermissionGuard(rules?: FilesystemPermission[]): PermissionGuard | undefined {
	if (!rules || rules.length === 0) {
		return undefined;
	}
	return new PermissionGuard(rules);
}
