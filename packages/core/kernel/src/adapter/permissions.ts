/**
 * Declarative filesystem permission types and evaluation.
 *
 * Permissions are glob-based rules that control filesystem access.
 * Each rule specifies operations, path patterns, and mode (allow/deny).
 * Evaluation uses first-match-wins semantics.
 */

/**
 * Filesystem operation types that can be controlled by permissions.
 */
export type FilesystemOperation = "read" | "write" | "delete" | "execute";

/**
 * Permission mode: allow or deny matching paths.
 */
export type PermissionMode = "allow" | "deny";

/**
 * A single filesystem permission rule.
 *
 * @example
 * { operations: ["read"], paths: ["**\/*.ts"], mode: "allow" }
 * { operations: ["write", "delete"], paths: ["/etc/**"], mode: "deny" }
 */
export interface FilesystemPermission {
	/** Operations this rule applies to. */
	operations: FilesystemOperation[];
	/** Glob patterns matched against absolute file paths. */
	paths: string[];
	/** Whether to allow or deny matching operations. */
	mode: PermissionMode;
}

/**
 * Blueprint permission schema field.
 *
 * When present in a blueprint, these rules gate all filesystem operations.
 * Adapters must check permissions before executing tools.
 */
export interface PermissionSchema {
	/** Ordered list of permission rules (first match wins). */
	filesystem?: FilesystemPermission[];
}
