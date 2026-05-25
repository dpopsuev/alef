/**
 * Pill geometry — the ╭─ label ─╮ / ╰───────╯ border strings.
 *
 * Pure string functions: no TUI imports, no state.
 */

export function pillHeaderStr(label: string, width: number): string {
	const inner = `─ ${label} `;
	const fill = Math.max(0, width - inner.length - 2);
	return `╭${inner}${"─".repeat(fill)}╮`;
}

export function pillFooterStr(width: number): string {
	return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}
