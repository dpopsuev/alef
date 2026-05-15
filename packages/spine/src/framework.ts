/**
 * Organ framework — defineCorpusOrgan / defineCerebrumOrgan.
 *
 * Eliminates the four patterns every organ repeats:
 *   1. makeSense/errSense helpers
 *   2. nerve.motor.subscribe loop
 *   3. return () => { unsub1(); unsub2(); ... }
 *   4. try/catch error wrapping
 *
 * Organ authors write only domain logic.
 */

import type {
	CerebrumNerve,
	CerebrumOrgan,
	CorpusNerve,
	CorpusOrgan,
	MotorEvent,
	SenseEvent,
	ToolDefinition,
} from "./buses.js";

// ---------------------------------------------------------------------------
// CorpusOrgan framework
// ---------------------------------------------------------------------------

/** Context passed to every CorpusOrgan action handler. */
export interface CorpusHandlerCtx {
	/** Correlation ID from the Motor event — thread through to Sense. */
	readonly correlationId: string;
	/** toolCallId from Motor payload — mirrored to Sense payload for LLM correlation. */
	readonly toolCallId: string | undefined;
	/** The full Motor payload. */
	readonly payload: Record<string, unknown>;
}

/** Standard (non-streaming) CorpusOrgan action. Returns result payload or throws. */
export interface CorpusAction {
	/** Present → exposed as an LLM-callable tool. Absent → internal. */
	readonly tool?: ToolDefinition;
	handle(ctx: CorpusHandlerCtx): Promise<Record<string, unknown>>;
}

/**
 * Streaming CorpusOrgan action — Channel pattern.
 * Yields partial payloads; framework emits each as a Sense event.
 * The last yielded value is marked isFinal: true.
 */
export interface StreamingCorpusAction {
	readonly tool?: ToolDefinition;
	stream(ctx: CorpusHandlerCtx): AsyncIterable<Record<string, unknown>>;
}

/** Motor event type → action definition. */
export type CorpusActionMap = Record<string, CorpusAction | StreamingCorpusAction>;

function isStreaming(action: CorpusAction | StreamingCorpusAction): action is StreamingCorpusAction {
	return "stream" in action;
}

function extractToolCallId(payload: Record<string, unknown>): string | undefined {
	return typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
}

function buildSense(
	motor: MotorEvent,
	payload: Record<string, unknown>,
	isError = false,
	errorMessage?: string,
): SenseEvent {
	const toolCallId = extractToolCallId(motor.payload);
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		timestamp: Date.now(),
		payload: toolCallId ? { ...payload, toolCallId } : payload,
		isError,
		errorMessage,
	};
}

function buildErrSense(motor: MotorEvent, message: string): SenseEvent {
	const toolCallId = extractToolCallId(motor.payload);
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		timestamp: Date.now(),
		payload: toolCallId ? { toolCallId } : {},
		isError: true,
		errorMessage: message,
	};
}

async function dispatchCorpusAction(
	motor: MotorEvent,
	action: CorpusAction | StreamingCorpusAction,
	nerve: CorpusNerve,
): Promise<void> {
	const ctx: CorpusHandlerCtx = {
		correlationId: motor.correlationId,
		toolCallId: extractToolCallId(motor.payload),
		payload: motor.payload,
	};

	if (isStreaming(action)) {
		// Streaming path — emit each chunk as a Sense event, mark final on last.
		try {
			let last: Record<string, unknown> | undefined;
			for await (const chunk of action.stream(ctx)) {
				if (last !== undefined) {
					nerve.sense.publish(buildSense(motor, { ...last, isFinal: false }));
				}
				last = chunk;
			}
			if (last !== undefined) {
				nerve.sense.publish(buildSense(motor, { ...last, isFinal: true }));
			} else {
				nerve.sense.publish(buildSense(motor, { isFinal: true }));
			}
		} catch (e) {
			nerve.sense.publish(buildErrSense(motor, e instanceof Error ? e.message : String(e)));
		}
	} else {
		// Standard path — single Sense event.
		try {
			const result = await action.handle(ctx);
			nerve.sense.publish(buildSense(motor, result));
		} catch (e) {
			nerve.sense.publish(buildErrSense(motor, e instanceof Error ? e.message : String(e)));
		}
	}
}

/**
 * defineCorpusOrgan — create a CorpusOrgan from an action map.
 *
 * @example
 * ```ts
 * export const createFsOrgan = (opts: FsOrganOptions) =>
 *   defineCorpusOrgan("fs", {
 *     "fs.read": { tool: FS_READ_TOOL, handle: (ctx) => readFile(ctx, opts) },
 *     "fs.grep": { tool: FS_GREP_TOOL, handle: (ctx) => grepFiles(ctx, opts) },
 *   });
 * ```
 */
export function defineCorpusOrgan(name: string, actions: CorpusActionMap): CorpusOrgan {
	const tools: ToolDefinition[] = Object.values(actions)
		.filter((a) => a.tool !== undefined)
		.map((a) => a.tool as ToolDefinition);

	return {
		kind: "corpus",
		name,
		tools,
		mount(nerve: CorpusNerve): () => void {
			const unsubs = Object.entries(actions).map(([eventType, action]) =>
				nerve.motor.subscribe(eventType, (event) => void dispatchCorpusAction(event, action, nerve)),
			);
			return () => {
				for (const off of unsubs) off();
			};
		},
	};
}

// ---------------------------------------------------------------------------
// CerebrumOrgan framework
// ---------------------------------------------------------------------------

/** Context passed to every CerebrumOrgan action handler. */
export interface CerebrumHandlerCtx {
	readonly correlationId: string;
	readonly payload: Record<string, unknown>;
	/** Publish Motor events — use for fan-out tool calls. */
	readonly motor: CerebrumNerve["motor"];
	/** Subscribe to Sense events — use for awaiting tool results. */
	readonly sense: CerebrumNerve["sense"];
}

/** One action a CerebrumOrgan handles. */
export interface CerebrumAction {
	handle(ctx: CerebrumHandlerCtx): Promise<void>;
}

/** Sense event type → action definition. */
export type CerebrumActionMap = Record<string, CerebrumAction>;

/**
 * defineCerebrumOrgan — create a CerebrumOrgan from an action map.
 *
 * @example
 * ```ts
 * export const createLLMOrgan = (opts: LLMOrganOptions) =>
 *   defineCerebrumOrgan("llm", {
 *     "dialog.message": { handle: (ctx) => runLLMLoop(ctx, opts) },
 *   });
 * ```
 */
export function defineCerebrumOrgan(name: string, actions: CerebrumActionMap): CerebrumOrgan {
	return {
		kind: "cerebrum",
		name,
		tools: [],
		mount(nerve: CerebrumNerve): () => void {
			const unsubs = Object.entries(actions).map(([eventType, action]) =>
				nerve.sense.subscribe(eventType, (event) => {
					const ctx: CerebrumHandlerCtx = {
						correlationId: event.correlationId,
						payload: event.payload,
						motor: nerve.motor,
						sense: nerve.sense,
					};
					void action.handle(ctx).catch(() => {
						// Cerebrum organs don't publish Sense on error —
						// they own their own error handling (LLMOrgan retries, etc.)
					});
				}),
			);
			return () => {
				for (const off of unsubs) off();
			};
		},
	};
}

// Re-export helpers for organs that need manual Sense construction (DialogOrgan.receive())
export { buildSense, buildErrSense };
