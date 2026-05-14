/**
 * ShellCorpusOrgan — ShellOrgan as a CorpusOrgan.
 *
 * Subscribes Motor/"shell.exec", executes the command, publishes
 * Sense/"shell.exec" with stdout+stderr and exit code.
 *
 * Note: this is the non-streaming path. The bash tool in coding-agent
 * has its own streaming via onUpdate for TUI use. This organ handles
 * headless/bus-routed execution.
 */
import type { CorpusNerve, CorpusOrgan, MotorEvent, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";
import { getShellEnv } from "./shell.js";
import { createPlatformShellAdapter } from "./shell-adapter.js";

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const SHELL_EXEC_TOOL: ToolDefinition = {
	name: "shell.exec",
	description:
		"Execute a shell command and return stdout+stderr. Non-streaming. Use for headless/scripted execution. For interactive TUI sessions use the bash tool instead.",
	inputSchema: {
		type: "object",
		properties: {
			command: { type: "string", description: "Shell command to execute" },
			timeout: { type: "number", description: "Timeout in seconds (optional)" },
		},
		required: ["command"],
	},
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ShellOrganOptions {
	/** Working directory for command execution. */
	cwd: string;
	/** Optional shell path override. */
	shellPath?: string;
	/** Optional shell command prefix. */
	commandPrefix?: string;
	/** Optional bin dir to inject into PATH. */
	binDir?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSense(
	motor: MotorEvent,
	payload: Record<string, unknown>,
	isError = false,
	errorMessage?: string,
): SenseEvent {
	// Mirror toolCallId if present so LLMOrgan can correlate tool results.
	const toolCallId = typeof motor.payload.toolCallId === "string" ? motor.payload.toolCallId : undefined;
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		timestamp: Date.now(),
		payload: toolCallId ? { ...payload, toolCallId } : payload,
		isError,
		errorMessage,
	};
}

// ---------------------------------------------------------------------------
// Action handler
// ---------------------------------------------------------------------------

async function handleExec(motor: MotorEvent, nerve: CorpusNerve, opts: ShellOrganOptions): Promise<void> {
	const args = motor.payload;
	const command = String(args.command ?? "");
	const timeout = typeof args.timeout === "number" ? args.timeout : undefined;
	const resolvedCommand = opts.commandPrefix ? `${opts.commandPrefix}\n${command}` : command;

	try {
		const adapter = createPlatformShellAdapter();
		const chunks: Buffer[] = [];

		const { exitCode } = await adapter.execute({
			command: resolvedCommand,
			cwd: opts.cwd,
			onData: (data) => chunks.push(data),
			timeout,
			shellPath: opts.shellPath,
			env: getShellEnv({ binDir: opts.binDir }),
		});

		const text = Buffer.concat(chunks).toString("utf-8");
		const ok = exitCode === 0 || exitCode === null;

		nerve.sense.publish(
			makeSense(
				motor,
				{ text: text || "(no output)", exitCode: exitCode ?? 0 },
				!ok,
				!ok ? `Exit code ${exitCode}` : undefined,
			),
		);
	} catch (err) {
		nerve.sense.publish(
			makeSense(motor, { text: "", exitCode: -1 }, true, err instanceof Error ? err.message : String(err)),
		);
	}
}

// ---------------------------------------------------------------------------
// CorpusOrgan factory
// ---------------------------------------------------------------------------

/**
 * Create the shell organ as a CorpusOrgan.
 *
 * @example
 * ```typescript
 * import { createShellOrgan } from "@dpopsuev/alef-organ-shell";
 * import { Corpus } from "@dpopsuev/alef-corpus";
 *
 * const corpus = new Corpus();
 * corpus.load(createShellOrgan({ cwd: process.cwd() }));
 * ```
 */
export function createShellOrgan(options: ShellOrganOptions): CorpusOrgan {
	return {
		kind: "corpus",
		name: "shell",
		tools: [SHELL_EXEC_TOOL],

		mount(nerve: CorpusNerve): () => void {
			return nerve.motor.subscribe("shell.exec", (event) => handleExec(event, nerve, options));
		},
	};
}
