/**
 * ANSI escape sequence utilities — stripping, detection, sanitization.
 *
 * Prevents ANSI codes from tool output bleeding through as literal text
 * in the TUI (e.g. shell.exec capturing terminal output with color codes).
 */

/** ANSI escape sequence pattern: ESC[...m for SGR (color/style). */
const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Strip all ANSI SGR (Select Graphic Rendition) codes from text.
 *
 * Use this before rendering tool output that might contain raw ANSI codes
 * from shell commands, logs, or other terminal sources.
 *
 * @example
 *   stripAnsi("\x1b[1mBold\x1b[0m text") // => "Bold text"
 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_SGR_PATTERN, "");
}

/**
 * Detect if text contains any ANSI escape sequences.
 *
 * Useful for conditional stripping (only strip when needed).
 */
export function hasAnsi(text: string): boolean {
	return ANSI_SGR_PATTERN.test(text);
}

/** Format a millisecond duration as a compact human-readable string. */
export function fmtMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const remainS = Math.round(s % 60);
	return remainS > 0 ? `${m}m ${remainS}s` : `${m}m`;
}

/**
 * Sanitize text for TUI display:
 *   1. Strip ANSI codes (prevents literal \x1b[1m in output)
 *   2. Normalize line endings (CRLF → LF)
 *   3. Remove null bytes (can break terminal rendering)
 *
 * Apply this to all tool output before passing to Text/Markdown components.
 */
export function sanitizeForDisplay(text: string): string {
	return stripAnsi(text)
		.replace(/\r\n/g, "\n") // Normalize Windows line endings
		.replace(/\0/g, ""); // Strip null bytes
}
