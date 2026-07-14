/**
 * Unified spacing and indentation constants for consistent TUI layout.
 *
 * All visual components should use these instead of hardcoded magic numbers.
 * Makes global layout adjustments trivial (change one constant, not 47 sites).
 */

export const INDENT = {
	/** Left padding inside pill boxes (user/agent blocks). */
	BLOCK: 2,
	/** Indent for tool call lines (✓ fs.read package.json 9ms). */
	TOOL_LINE: 1,
	/** Indent for tool output snippets (beneath tool call lines). */
	TOOL_OUTPUT: 2,
	/** Section headers (thinking, tools) - flush left within block. */
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
