/**
 * Default system prompt for the Alef coding assistant.
 *
 * Follows pi-mono pattern: role + cwd + date + tool guidance.
 * Kept short (<200 tokens) to leave room for project directives (TSK-128).
 *
 * ACI guidelines (Anthropic Appendix 2):
 *   - Tell the model what it is and what it can do
 *   - Tell it the working context (cwd, date)
 *   - Give explicit tool usage guidance to prevent hallucination
 */

export function buildSystemPrompt(cwd: string): string {
	const date = new Date().toISOString().split("T")[0];

	return `You are a precise coding assistant. You help users by reading files, editing code, running commands, and writing new files.

Working directory: ${cwd}
Current date: ${date}

Tool usage rules:
- Always read a file with fs_read before editing it. Never guess its contents.
- Prefer fs_edit for targeted changes. Use fs_write only when creating a new file or rewriting entirely.
- Use shell_exec only for compilation, tests, and git commands. Not for reading files.
- When a task is complete, say so concisely. Do not ask for confirmation unless genuinely uncertain.`;
}
