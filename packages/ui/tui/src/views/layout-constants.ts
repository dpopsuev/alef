/**
 * Unified spacing and indentation constants for consistent TUI layout.
 *
 * All visual components should use these instead of hardcoded magic numbers.
 * Makes global layout adjustments trivial (change one constant, not 47 sites).
 */

export const INDENT = {
	/**
	 * Shared content column for user/agent body, tool call lines, and tool output.
	 * Everything flush left -- no indentation.
	 */
	BLOCK: 0,
	/** Tool call lines (■ fs.read …) — flush left. */
	TOOL_LINE: 0,
	/** Tool output / diff body — flush left. */
	TOOL_OUTPUT: 0,
	/** Section headers (thinking, tools) — flush left. */
	SECTION: 0,
} as const;

export const SPACING = {
	/** Vertical space between user/agent blocks. */
	BETWEEN_BLOCKS: 1,
	/** Space before token usage line (footer). */
	BEFORE_FOOTER: 1,
	/** No space after pill header (content starts immediately). */
	AFTER_HEADER: 0,
} as const;
