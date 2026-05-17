/**
 * ScriptStep — describes one LLM turn's scripted behaviour.
 *
 * Used by ScriptedLLMOrgan to simulate the LLM without a real API call.
 *
 * ScriptStep types:
 *   reply(text)                  — simple text reply, no tool calls
 *   toolCall(name, args, reply)  — one tool call, wait for result, then reply
 *   toolCalls([...], reply)      — parallel tool calls, wait for all, then reply
 *
 * Tool names use EDA event types (fs.read, shell.exec) not LLM names (fs_read).
 * The real organ handlers execute — tool results are real.
 */

export interface ToolCallSpec {
	/** EDA Motor event type (e.g. "fs.read", "lector.search"). */
	name: string;
	/** Arguments forwarded to the organ handler. */
	args: Record<string, unknown>;
}

export type ScriptStep =
	| {
			/** Simple text reply — no tool calls. */
			readonly kind: "reply";
			readonly text: string;
	  }
	| {
			/** One tool call, then text reply. */
			readonly kind: "toolCall";
			readonly call: ToolCallSpec;
			readonly reply: string;
	  }
	| {
			/** Parallel tool calls, then text reply. */
			readonly kind: "toolCalls";
			readonly calls: readonly ToolCallSpec[];
			readonly reply: string;
	  };

// ---------------------------------------------------------------------------
// Builder helpers — ergonomic step construction
// ---------------------------------------------------------------------------

export const step = {
	/**
	 * Simple text reply — LLM responds without calling any tools.
	 * @example step.reply("The login function validates password length.")
	 */
	reply(text: string): ScriptStep {
		return { kind: "reply", text };
	},

	/**
	 * One tool call followed by a text reply.
	 * The real organ handler executes; its Sense result is available in assertions.
	 * @example step.toolCall("fs.read", { path: "src/auth.ts" }, "I found the bug.")
	 */
	toolCall(name: string, args: Record<string, unknown>, reply: string): ScriptStep {
		return { kind: "toolCall", call: { name, args }, reply };
	},

	/**
	 * Parallel tool calls followed by a text reply.
	 * All tool calls are published simultaneously; all results awaited before reply.
	 * @example step.toolCalls([
	 *   { name: "fs.read", args: { path: "src/a.ts" } },
	 *   { name: "fs.read", args: { path: "src/b.ts" } },
	 * ], "I read both files.")
	 */
	toolCalls(calls: ToolCallSpec[], reply: string): ScriptStep {
		return { kind: "toolCalls", calls, reply };
	},
};
