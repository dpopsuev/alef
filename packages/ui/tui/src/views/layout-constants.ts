/**
 * Unified spacing and indentation constants for consistent TUI layout.
 *
 * All visual components should use these instead of hardcoded magic numbers.
 * Makes global layout adjustments trivial (change one constant, not 47 sites).
 */

export const INDENT = {
	/**
	 * Shared content column for user/agent body, tool call lines, and tool output.
	 * Speakers stay flush left; everything under them starts here.
	 */
	BLOCK: 2,
	/** Tool call lines (■ fs.read …) — same column as prose. */
	TOOL_LINE: 2,
	/** Tool output / diff body — same column as prose (do not stack on Pad(BLOCK)). */
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
