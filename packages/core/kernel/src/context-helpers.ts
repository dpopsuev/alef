type RawMsg = { role?: string; content?: unknown };

/**
 * Inject a text block into the message array after the system message.
 * Used by adapters that contribute context via context.assemble (memory, scribe, board).
 * DRY: replaces duplicated splice logic across three adapters.
 */
export function injectContextBlock(messages: readonly unknown[], block: string): unknown[] {
	const result = [...messages];
	const systemIdx = result.findIndex((m) => (m as RawMsg).role === "system");
	const insertAt = systemIdx >= 0 ? systemIdx + 1 : 0;
	result.splice(insertAt, 0, { role: "user", content: block });
	return result;
}
