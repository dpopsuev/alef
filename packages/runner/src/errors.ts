/**
 * Error formatting for the runner — turns raw errors into human-readable messages.
 *
 * Per-turn errors must not crash the session. Print and continue.
 */

export function formatError(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);

	if (msg.includes("timed out")) {
		return "[error] Request timed out. The model may be slow or unavailable. Try again.";
	}
	if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
		return "[error] Rate limited. Wait a moment and try again.";
	}
	if (msg.includes("context") && msg.includes("long")) {
		return "[error] Context too long. Start a new session with a fresh working directory.";
	}
	if (msg.includes("unmounted") || msg.includes("disposed")) {
		return "[error] Agent session ended unexpectedly.";
	}

	return `[error] ${msg}`;
}
