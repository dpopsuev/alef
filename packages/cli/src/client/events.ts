import type { UiSignalHandler } from "@dpopsuev/alef-kernel/adapter";
import { formatErrorForUser } from "@dpopsuev/alef-kernel/errors";
import type { TaskSnapshot } from "@dpopsuev/alef-kernel/execution";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { AgentEvent } from "@dpopsuev/alef-session/contracts";
import { formatTokenUsage, formatToolArgs } from "@dpopsuev/alef-tui/views";
import { applyIntents } from "./apply-intents.js";
import type { RenderIntent } from "./render-intent.js";
import type { DispatchPorts, DispatchState, OverlayDescriptor, TaskLedgerEntry, TokenFooterHandle } from "./state.js";
import { flushCompactionPark } from "./submit.js";
import type { ThemeTokens } from "./theme.js";

/** TUI input events -- dot convention (turn.start) vs AgentEvent hyphens (tool-start). */
export type InputEvent =
	| { type: "overlay.show"; descriptor: OverlayDescriptor }
	| { type: "overlay.hide"; id: string }
	| { type: "turn.start"; timestamp: number }
	| { type: "turn.complete"; tokenFooter: TokenFooterHandle }
	| { type: "turn.abort" }
	| { type: "turn.interrupt" }
	| { type: "turn.error"; error: unknown; aborted: boolean }
	| { type: "abort.set"; fn: () => void }
	| { type: "abort.clear" }
	| { type: "thinking.toggle" }
	| { type: "inspector.cycle" }
	| { type: "inspector.close" }
	| { type: "inspector.scroll"; direction: -1 | 1 }
	| { type: "inspector.cancel" }
	| { type: "thinking.tick" }
	| { type: "toast.expired" };

/** Union of agent-emitted events and TUI input events dispatched through the TUI state machine. */
export type DispatchEvent = AgentEvent | InputEvent;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TASK_CHUNK_TAIL_LIMIT = 20;
const TASK_TOAST_DURATION_MS = 5000;
const INSPECTOR_LINES = 12;
const INSPECTOR_SCROLL_STEP = 3;

// ---------------------------------------------------------------------------
// DispatchContext -- data the pure function needs beyond state + event
// ---------------------------------------------------------------------------

/** Context values the pure dispatch function reads but never mutates. */
export interface DispatchContext {
	/** Theme tokens (needed for agentFg color and formatTokenUsage). */
	readonly t: ThemeTokens;
	/** Current hideThinking toggle value from replyBlock. */
	readonly hideThinking: boolean;
	/** Signal handler map for adapter-signal events (unused in pure path). */
	readonly signalHandlers?: ReadonlyMap<string, UiSignalHandler>;
}

// ---------------------------------------------------------------------------
// Helper -- task entry
// ---------------------------------------------------------------------------

/** Build a ledger entry from a task lifecycle snapshot. */
function taskEntryFromEvent(task: TaskSnapshot): TaskLedgerEntry {
	return {
		taskId: task.descriptor.taskId,
		profile: task.descriptor.profile,
		status: task.status,
		startedAt: task.startedAt,
		lastActivityAt: task.lastActivityAt,
		completedAt: task.completedAt,
		ownerAddress: task.descriptor.actorAddress,
		modelId: task.descriptor.modelId,
		planId: task.descriptor.planId,
		stepId: task.descriptor.stepId,
		discourseTopic: task.descriptor.discourseTopic,
		discourseThread: task.descriptor.discourseThread,
		work: task.descriptor.work,
		attempt: task.descriptor.attempt,
		chunkTail: [],
		reply: task.reply,
		error: task.error,
	};
}

// ---------------------------------------------------------------------------
// Render helpers -- pure functions producing intents
// ---------------------------------------------------------------------------

/** Render a scrollable window of tool output chunks for the inspector detail view. */
export function renderChunkWindow(chunks: string[], scrollOffset: number): string {
	const all = chunks.join("").split("\n");
	const end = Math.max(0, all.length - scrollOffset);
	const start = Math.max(0, end - INSPECTOR_LINES);
	return all.slice(start, end).join("\n");
}

/** Emit intents to flush typewriters and reset the reply block. */
function emitResetUI(intents: RenderIntent[]): void {
	intents.push({ kind: "flush-reply-tw" });
	intents.push({ kind: "flush-thinking-tw" });
	intents.push({ kind: "reset-reply-block" });
}

/** Emit intents for setting the focused call in the inspector and rendering its chunk window. */
function emitUpdateInspectorView(
	intents: RenderIntent[],
	state: DispatchState,
	callId: string | null,
	scrollOffset = 0,
): void {
	intents.push({ kind: "set-focused-call", callId });
	if (callId && state.callChunks.has(callId)) {
		const chunks = state.callChunks.get(callId) ?? [];
		intents.push({ kind: "set-chunk-text", text: renderChunkWindow(chunks, scrollOffset) });
	} else {
		intents.push({ kind: "set-chunk-text", text: "" });
	}
}

// ---------------------------------------------------------------------------
// Pure helper dispatchers
// ---------------------------------------------------------------------------

/** Process a tool-end event: compute state changes and emit intents. */
function handleToolEndPure(
	state: DispatchState,
	event: Extract<AgentEvent, { type: "tool-end" }>,
	intents: RenderIntent[],
): DispatchState {
	const { callId, elapsedMs, ok, display, displayKind } = event;
	const entry = state.activeCalls.get(callId);
	if (!entry) return state;

	traceEvent("tool:end", {
		callId: callId.slice(0, 8),
		name: entry.name,
		elapsedMs,
		ok,
		remainingActive: state.activeCalls.size - 1,
	});

	intents.push({ kind: "remove-in-flight-call", callId });

	const validationErrs = state.validationErrors.get(callId) ?? [];
	let enhancedDisplay = display?.trim() ? display : null;
	if (validationErrs.length > 0) {
		const errSection = validationErrs.join("\n");
		enhancedDisplay = enhancedDisplay ? `${errSection}\n\n${enhancedDisplay}` : errSection;
	}

	intents.push({
		kind: "append-tool-result",
		name: entry.name,
		keyArg: entry.keyArg,
		args: entry.args,
		elapsedMs,
		ok,
		display: enhancedDisplay,
		displayKind: display?.trim() ? (displayKind ?? null) : null,
	});

	const innerReply = state.innerReplies.get(callId);
	if (innerReply?.trim()) {
		intents.push({ kind: "append-subagent-reply", name: entry.name, reply: innerReply });
	}

	const activeCalls = new Map(state.activeCalls);
	activeCalls.delete(callId);

	const callChunks = new Map(state.callChunks);
	callChunks.delete(callId);

	const validationErrors = new Map(state.validationErrors);
	validationErrors.delete(callId);

	const exitCodes = new Map(state.exitCodes);
	exitCodes.delete(callId);

	const innerReplies = new Map(state.innerReplies);
	innerReplies.delete(callId);

	const batchDone = activeCalls.size === 0 && state.batchStartedAt !== null;
	if (batchDone && state.batchCallCount > 1) {
		intents.push({ kind: "append-batch-timing", elapsedMs: Date.now() - (state.batchStartedAt ?? 0) });
	}

	const focusLost = state.focusedCallId === callId;
	let nextFocus: string | null;
	if (focusLost) {
		if (activeCalls.size > 0) {
			nextFocus = activeCalls.keys().next().value ?? null;
		} else {
			nextFocus = null;
		}
	} else {
		nextFocus = state.focusedCallId;
	}

	if (focusLost) {
		emitUpdateInspectorView(intents, state, nextFocus, 0);
	}

	if (batchDone) {
		emitUpdateInspectorView(intents, state, null);
	}

	return {
		...state,
		activeCalls,
		callChunks,
		validationErrors,
		exitCodes,
		innerReplies,
		batchStartedAt: batchDone ? null : state.batchStartedAt,
		batchCallCount: batchDone ? 0 : state.batchCallCount,
		focusedCallId: batchDone ? null : (nextFocus ?? null),
	};
}

/** Handle a turn error: emit cleanup intents and reset active state. */
function handleTurnErrorPure(
	state: DispatchState,
	event: Extract<InputEvent, { type: "turn.error" }>,
	intents: RenderIntent[],
): DispatchState {
	intents.push({ kind: "stop-thinking" });
	intents.push({ kind: "hide-pending-footer" });
	intents.push({ kind: "reset-reply-tw" });
	intents.push({ kind: "reset-thinking-tw" });
	intents.push({ kind: "clear-reply-block" });

	for (const [callId, entry] of state.activeCalls) {
		intents.push({ kind: "remove-in-flight-call", callId });
		intents.push({
			kind: "append-tool-result",
			name: entry.name,
			keyArg: entry.keyArg,
			args: entry.args,
			elapsedMs: 0,
			ok: false,
			display: null,
			displayKind: null,
		});
	}

	if (!event.aborted) {
		intents.push({ kind: "append-notice", text: `[error] ${formatErrorForUser(event.error)}` });
	}

	return {
		...state,
		activeCalls: new Map(),
		batchStartedAt: null,
		batchCallCount: 0,
		pendingFooterShown: false,
		abortCurrentTurn: undefined,
	};
}

/** Cycle inspector focus to the next active tool call (pure). */
function handleInspectorCyclePure(state: DispatchState, intents: RenderIntent[]): DispatchState {
	if (state.activeCalls.size === 0) return state;
	const ids = [...state.activeCalls.keys()];
	const idx = state.focusedCallId ? ids.indexOf(state.focusedCallId) : -1;
	const nextId = ids[(idx + 1) % ids.length]!;
	emitUpdateInspectorView(intents, state, nextId, state.inspectorScrollOffset);
	return { ...state, focusedCallId: nextId };
}

/** Close the inspector and clear focus (pure). */
function handleInspectorClosePure(state: DispatchState, intents: RenderIntent[]): DispatchState {
	emitUpdateInspectorView(intents, state, null);
	return { ...state, focusedCallId: null, inspectorScrollOffset: 0 };
}

/** Scroll the inspector chunk detail view (pure). */
function handleInspectorScrollPure(state: DispatchState, intents: RenderIntent[], direction: -1 | 1): DispatchState {
	if (!state.focusedCallId) return state;
	const chunks = state.callChunks.get(state.focusedCallId) ?? [];
	const totalLines = chunks.join("").split("\n").length;
	const maxScroll = Math.max(0, totalLines - INSPECTOR_LINES);
	const next = Math.max(0, Math.min(maxScroll, state.inspectorScrollOffset + direction * INSPECTOR_SCROLL_STEP));
	intents.push({ kind: "set-chunk-text", text: renderChunkWindow(chunks, next) });
	return { ...state, inspectorScrollOffset: next };
}

/** Cancel the currently focused tool call (pure). */
function handleInspectorCancelPure(state: DispatchState, intents: RenderIntent[]): DispatchState {
	if (!state.focusedCallId) return state;
	const entry = state.activeCalls.get(state.focusedCallId);
	if (!entry) return state;
	intents.push({ kind: "cancel-tool-call", callId: state.focusedCallId, name: entry.name });
	return state;
}

// ---------------------------------------------------------------------------
// computeDispatch -- pure state + intents function
// ---------------------------------------------------------------------------

/** Pure dispatch: compute new state and render intents without touching UI components. */
export function computeDispatch(
	state: DispatchState,
	event: DispatchEvent,
	ctx: DispatchContext,
): { state: DispatchState; intents: RenderIntent[] } {
	traceEvent("tui:dispatch", { eventType: event.type });
	const intents: RenderIntent[] = [];

	if (event.type === "state-changed") {
		return { state, intents };
	}

	if (event.type === "discussion-changed") {
		intents.push({ kind: "set-topic-label", text: event.discussion.active.topicTitle });
		return { state, intents };
	}

	// adapter-signal is handled by the outer dispatchEvent -- not here.
	if (event.type === "adapter-signal") {
		return { state, intents };
	}

	// -- Input event handlers ------------------------------------------------

	if (event.type === "overlay.show") {
		return { state: { ...state, overlays: [...state.overlays, event.descriptor] }, intents };
	}

	if (event.type === "overlay.hide") {
		return { state: { ...state, overlays: state.overlays.filter((o) => o.id !== event.id) }, intents };
	}

	if (event.type === "turn.start") {
		intents.push({ kind: "hide-pending-footer" });
		intents.push({ kind: "start-thinking" });
		return { state: { ...state, pendingFooterShown: false, turnStartedAt: event.timestamp }, intents };
	}

	if (event.type === "turn.complete") {
		emitResetUI(intents);
		intents.push({ kind: "stop-thinking" });
		intents.push({ kind: "hide-pending-footer" });
		intents.push({ kind: "on-turn-complete" });
		return { state: { ...state, pendingFooterShown: false, pendingTokenFooter: event.tokenFooter }, intents };
	}

	if (event.type === "turn-complete") {
		emitResetUI(intents);
		intents.push({ kind: "stop-thinking" });
		intents.push({ kind: "hide-pending-footer" });
		intents.push({ kind: "on-turn-complete" });
		return { state: { ...state, pendingFooterShown: false }, intents };
	}

	if (event.type === "turn.abort") {
		return { state: { ...state, abortCurrentTurn: undefined }, intents };
	}

	if (event.type === "turn.interrupt") {
		if (!state.abortCurrentTurn) return { state, intents };
		state.abortCurrentTurn();
		emitResetUI(intents);
		intents.push({ kind: "stop-thinking" });
		intents.push({ kind: "hide-pending-footer" });
		for (const [callId] of state.activeCalls) {
			intents.push({ kind: "remove-in-flight-call", callId });
		}
		intents.push({ kind: "append-notice", text: "(interrupted)" });
		return {
			state: {
				...state,
				activeCalls: new Map(),
				pendingFooterShown: false,
				abortCurrentTurn: undefined,
			},
			intents,
		};
	}

	if (event.type === "turn.error") {
		return { state: handleTurnErrorPure(state, event, intents), intents };
	}

	if (event.type === "abort.set") {
		return { state: { ...state, abortCurrentTurn: event.fn }, intents };
	}

	if (event.type === "abort.clear") {
		return { state: { ...state, abortCurrentTurn: undefined }, intents };
	}

	if (event.type === "thinking.toggle") {
		const next = !ctx.hideThinking;
		intents.push({ kind: "set-hide-thinking", hide: next });
		intents.push({ kind: "append-notice", text: next ? "Thinking: hidden" : "Thinking: visible" });
		return { state, intents };
	}

	if (event.type === "inspector.cycle") {
		return { state: handleInspectorCyclePure(state, intents), intents };
	}

	if (event.type === "inspector.close") {
		return { state: handleInspectorClosePure(state, intents), intents };
	}

	if (event.type === "inspector.cancel") {
		return { state: handleInspectorCancelPure(state, intents), intents };
	}

	if (event.type === "inspector.scroll") {
		return { state: handleInspectorScrollPure(state, intents, event.direction), intents };
	}

	if (event.type === "thinking.tick") {
		intents.push({ kind: "thinking-tick" });
		return { state, intents };
	}

	if (event.type === "toast.expired") {
		intents.push({ kind: "toast-expired" });
		return { state, intents };
	}

	// -- Agent event handlers ------------------------------------------------

	if (event.type === "tool-start") {
		const { callId, name, args } = event;
		const keyArg = formatToolArgs(args);
		traceEvent("tool:start", {
			callId: callId.slice(0, 8),
			name,
			keyArg,
			activeCount: state.activeCalls.size + 1,
		});
		intents.push({ kind: "pulse" });
		emitResetUI(intents);
		intents.push({ kind: "show-in-flight-call", callId, name, keyArg, args });
		if (!state.pendingFooterShown) intents.push({ kind: "show-pending-footer", fg: ctx.t.agentFg });
		const activeCalls = new Map(state.activeCalls);
		activeCalls.set(callId, { name, keyArg, args, children: new Map(), depth: 0 });
		const startingBatch = state.batchStartedAt === null;
		return {
			state: {
				...state,
				activeCalls,
				batchStartedAt: state.batchStartedAt ?? Date.now(),
				batchCallCount: startingBatch ? 1 : state.batchCallCount + 1,
				pendingFooterShown: true,
			},
			intents,
		};
	}

	if (event.type === "tool-end") {
		return { state: handleToolEndPure(state, event, intents), intents };
	}

	if (event.type === "inner-tool-start") {
		const parent = state.activeCalls.get(event.parentCallId);
		if (!parent) return { state, intents };
		const childKeyArg = formatToolArgs(event.args);
		parent.children.set(event.callId, {
			name: event.name,
			keyArg: childKeyArg,
			args: event.args,
			parentCallId: event.parentCallId,
			children: new Map(),
			depth: parent.depth + 1,
		});
		intents.push({
			kind: "add-child-call",
			parentCallId: event.parentCallId,
			callId: event.callId,
			name: event.name,
			keyArg: childKeyArg,
			args: event.args,
			depth: parent.depth + 1,
		});
		return { state, intents };
	}

	if (event.type === "inner-tool-end") {
		const parent = state.activeCalls.get(event.parentCallId);
		if (!parent) return { state, intents };
		parent.children.delete(event.callId);
		intents.push({ kind: "remove-child-call", parentCallId: event.parentCallId, callId: event.callId });
		return { state, intents };
	}

	if (event.type === "inner-chunk") {
		const existing = state.innerReplies.get(event.parentCallId) ?? "";
		const innerReplies = new Map(state.innerReplies);
		innerReplies.set(event.parentCallId, existing + event.text);
		return { state: { ...state, innerReplies }, intents };
	}

	if (event.type === "token-usage") {
		const { input, output, totalTokens, costUsd } = event.usage;
		const sessionTokensTotal = state.sessionTokensTotal + input + output;
		const sessionInputTokens = state.sessionInputTokens + input;
		const sessionOutputTokens = state.sessionOutputTokens + output;
		const sessionCostUsd = state.sessionCostUsd + (costUsd ?? 0);
		const contextFillTokens = totalTokens > 0 ? totalTokens : state.contextFillTokens;
		if (state.pendingTokenFooter) {
			intents.push({
				kind: "set-token-footer-text",
				text: formatTokenUsage(input, output, ctx.t, Date.now() - state.turnStartedAt, sessionTokensTotal),
			});
		}
		return {
			state: {
				...state,
				sessionTokensTotal,
				sessionInputTokens,
				sessionOutputTokens,
				sessionCostUsd,
				contextFillTokens,
				pendingTokenFooter: null,
			},
			intents,
		};
	}

	if (event.type === "chunk") {
		intents.push({ kind: "pulse" });
		intents.push({ kind: "reply-chunk", text: event.text });
		if (!state.pendingFooterShown) {
			intents.push({ kind: "show-pending-footer", fg: ctx.t.agentFg });
			return { state: { ...state, pendingFooterShown: true }, intents };
		}
		return { state, intents };
	}

	if (event.type === "thinking") {
		intents.push({ kind: "pulse" });
		intents.push({ kind: "thinking-chunk", text: event.text });
		return { state, intents };
	}

	if (event.type === "subagent-identity") {
		intents.push({
			kind: "set-call-identity",
			callId: event.callId,
			colorName: event.color,
			address: event.address,
			modelId: event.modelId,
		});
		return { state, intents };
	}

	if (event.type === "subagent-token-usage") {
		intents.push({ kind: "update-call-tokens", callId: event.callId, input: event.input, output: event.output });
		return { state, intents };
	}

	if (event.type === "tool-chunk") {
		intents.push({ kind: "pulse" });
		intents.push({ kind: "update-in-flight-call-chunk", callId: event.callId, text: event.text });
		const chunks = state.callChunks.get(event.callId) ?? [];
		chunks.push(event.text);
		const callChunks = new Map(state.callChunks);
		callChunks.set(event.callId, chunks);
		if (state.focusedCallId === event.callId) {
			const tail = renderChunkWindow(chunks, state.inspectorScrollOffset);
			intents.push({ kind: "set-chunk-text", text: tail });
		}
		return { state: { ...state, callChunks }, intents };
	}

	if (event.type === "tool-stall") {
		intents.push({ kind: "pulse" });
		intents.push({
			kind: "update-in-flight-call-chunk",
			callId: event.callId,
			text: `${event.name}: running for ${Math.round(event.elapsedMs / 1_000)}s...`,
		});
		return { state, intents };
	}

	if (event.type === "tool-validation-error") {
		intents.push({ kind: "pulse" });
		const errorMsg = `\u26A0 invalid arg '${event.field}': ${event.message}`;
		intents.push({ kind: "update-in-flight-call-chunk", callId: event.callId, text: errorMsg });
		const errors = state.validationErrors.get(event.callId) ?? [];
		errors.push(errorMsg);
		const validationErrors = new Map(state.validationErrors);
		validationErrors.set(event.callId, errors);
		return { state: { ...state, validationErrors }, intents };
	}

	if (event.type === "turn-error") {
		intents.push({ kind: "pulse" });
		intents.push({ kind: "append-notice", text: `LLM error: ${event.message}` });
		return { state, intents };
	}

	if (event.type === "message-queued") {
		intents.push({
			kind: "sync-pending-queue",
			queueLength: event.queueLength,
			text: event.text,
			mode: event.mode,
		});
		return { state, intents };
	}

	if (event.type === "task-started") {
		const taskLedger = new Map(state.taskLedger);
		const task = taskEntryFromEvent(event.task);
		taskLedger.set(task.taskId, task);
		intents.push({ kind: "show-background-task", taskId: task.taskId, profile: task.profile });
		return { state: { ...state, taskLedger }, intents };
	}

	if (event.type === "task-progress") {
		const taskLedger = new Map(state.taskLedger);
		let task = taskLedger.get(event.task.descriptor.taskId);
		if (!task) {
			task = taskEntryFromEvent(event.task);
			taskLedger.set(task.taskId, task);
			intents.push({ kind: "show-background-task", taskId: task.taskId, profile: task.profile });
		}
		task.status = event.task.status;
		task.lastActivityAt = event.task.lastActivityAt;
		task.completedAt = event.task.completedAt;
		task.reply = event.task.reply;
		task.error = event.task.error;
		task.chunkTail.push(event.chunk);
		if (task.chunkTail.length > TASK_CHUNK_TAIL_LIMIT) {
			task.chunkTail.splice(0, task.chunkTail.length - TASK_CHUNK_TAIL_LIMIT);
		}
		return { state: { ...state, taskLedger }, intents };
	}

	if (event.type === "task-completed") {
		const taskLedger = new Map(state.taskLedger);
		const task = taskLedger.get(event.task.descriptor.taskId) ?? taskEntryFromEvent(event.task);
		task.status = "completed";
		task.completedAt = event.task.completedAt ?? Date.now();
		task.lastActivityAt = event.task.lastActivityAt;
		task.reply = event.reply;
		task.error = event.task.error;
		taskLedger.set(task.taskId, task);
		intents.push({ kind: "update-background-task", taskId: task.taskId, status: "completed" });
		intents.push({
			kind: "show-toast",
			message: `Task ${task.taskId} completed (${task.profile})`,
			durationMs: TASK_TOAST_DURATION_MS,
		});
		return { state: { ...state, taskLedger }, intents };
	}

	if (event.type === "task-failed") {
		const taskLedger = new Map(state.taskLedger);
		const task = taskLedger.get(event.task.descriptor.taskId) ?? taskEntryFromEvent(event.task);
		task.status = "failed";
		task.completedAt = event.task.completedAt ?? Date.now();
		task.lastActivityAt = event.task.lastActivityAt;
		task.error = event.error;
		task.reply = event.task.reply;
		taskLedger.set(task.taskId, task);
		intents.push({ kind: "update-background-task", taskId: task.taskId, status: "failed", detail: event.error });
		intents.push({
			kind: "show-toast",
			message: `Task ${task.taskId} failed: ${event.error}`,
			durationMs: TASK_TOAST_DURATION_MS,
		});
		return { state: { ...state, taskLedger }, intents };
	}

	if (event.type === "task-cancelled") {
		const taskLedger = new Map(state.taskLedger);
		const task = taskLedger.get(event.task.descriptor.taskId) ?? taskEntryFromEvent(event.task);
		task.status = "cancelled";
		task.completedAt = event.task.completedAt ?? Date.now();
		task.lastActivityAt = event.task.lastActivityAt;
		task.error = event.error ?? event.task.error;
		taskLedger.set(task.taskId, task);
		intents.push({ kind: "update-background-task", taskId: task.taskId, status: "failed", detail: task.error });
		intents.push({
			kind: "show-toast",
			message: `Task ${task.taskId} cancelled`,
			durationMs: TASK_TOAST_DURATION_MS,
		});
		return { state: { ...state, taskLedger }, intents };
	}

	// Unknown event type -- return state unchanged.
	return { state, intents };
}

// ---------------------------------------------------------------------------
// dispatchEvent -- backward-compatible wrapper
// ---------------------------------------------------------------------------

/** Route DispatchEvent through adapter signal handlers (OCP extension), then built-in transitions. */
export function dispatchEvent(
	state: DispatchState,
	event: DispatchEvent,
	ui: DispatchPorts,
	signalHandlers?: ReadonlyMap<string, UiSignalHandler>,
): DispatchState {
	const { promptConsole, session, writer, t } = ui;

	// adapter-signal is the one event type that requires direct ui mutation
	// because UiSignalHandler callbacks receive a surface object.
	if (event.type === "adapter-signal" && signalHandlers) {
		const handler = signalHandlers.get(event.signalType);
		if (handler) {
			handler(event.payload, {
				setIntent: (text) => promptConsole.setIntent(text),
				setStatus: (text, clearAfterTurns) => promptConsole.setStatus(text, clearAfterTurns),
				setNotice: (text, clearAfterTurns) => promptConsole.setNotice(text, clearAfterTurns),
				setWidgetAbove: (text) => promptConsole.setWidgetAbove(text),
				setTopicLabel: (text) => promptConsole.setTopicLabel(text),
			});
		}
		if (
			event.signalType === "session.metadata.refresh" &&
			typeof event.payload.title === "string" &&
			event.payload.title.trim()
		) {
			const title = event.payload.title.trim();
			if (title !== session.getDiscussion?.()?.topicTitle) {
				session.setDiscussion?.({ topicTitle: title });
			}
		}
		if (event.signalType === "context.compacting" && event.payload.active === false) {
			const flushed = flushCompactionPark(session);
			for (const text of flushed) {
				writer.addUserMessage(text);
			}
			if (flushed.length > 0) {
				promptConsole.syncPendingQueue({ queueLength: 0 });
			}
		}
		if (event.signalType === "context.compacted" && typeof event.payload.estimatedAfter === "number") {
			return { ...state, contextFillTokens: event.payload.estimatedAfter };
		}
		return state;
	}

	const ctx: DispatchContext = {
		t,
		hideThinking: ui.replyBlock.hideThinking,
		signalHandlers,
	};

	const savedFooter = state.pendingTokenFooter;
	const result = computeDispatch(state, event, ctx);
	applyIntents(ui, result.intents, savedFooter);
	return result.state;
}

// ---------------------------------------------------------------------------
// Exported helpers -- kept for backward compatibility
// ---------------------------------------------------------------------------

/** Set the focused call in the inspector and render its chunk window. */
export function updateInspectorView(
	state: DispatchState,
	ui: DispatchPorts,
	callId: string | null,
	scrollOffset = 0,
): void {
	ui.promptConsole.setFocusedCall(callId);
	if (callId && state.callChunks.has(callId)) {
		const chunks = state.callChunks.get(callId) ?? [];
		ui.promptConsole.setChunkText(renderChunkWindow(chunks, scrollOffset));
	} else {
		ui.promptConsole.setChunkText("");
	}
}

/** Cycle inspector focus to the next active tool call. */
export function handleInspectorCycle(state: DispatchState, ui: DispatchPorts): DispatchState {
	if (state.activeCalls.size === 0) return state;
	const ids = [...state.activeCalls.keys()];
	const idx = state.focusedCallId ? ids.indexOf(state.focusedCallId) : -1;
	const nextId = ids[(idx + 1) % ids.length]!;
	updateInspectorView(state, ui, nextId, state.inspectorScrollOffset);
	return { ...state, focusedCallId: nextId };
}

/** Close the inspector and clear focus from all tool calls. */
export function handleInspectorClose(state: DispatchState, ui: DispatchPorts): DispatchState {
	updateInspectorView(state, ui, null);
	return { ...state, focusedCallId: null, inspectorScrollOffset: 0 };
}

/** Scroll the inspector chunk detail view up or down by a fixed step. */
export function handleInspectorScroll(state: DispatchState, ui: DispatchPorts, direction: -1 | 1): DispatchState {
	if (!state.focusedCallId) return state;
	const chunks = state.callChunks.get(state.focusedCallId) ?? [];
	const totalLines = chunks.join("").split("\n").length;
	const maxScroll = Math.max(0, totalLines - INSPECTOR_LINES);
	const next = Math.max(0, Math.min(maxScroll, state.inspectorScrollOffset + direction * INSPECTOR_SCROLL_STEP));
	ui.promptConsole.setChunkText(renderChunkWindow(chunks, next));
	return { ...state, inspectorScrollOffset: next };
}

/** Cancel the currently focused tool call via the session. */
export function handleInspectorCancel(state: DispatchState, ui: DispatchPorts): DispatchState {
	if (!state.focusedCallId) return state;
	const entry = state.activeCalls.get(state.focusedCallId);
	if (!entry) return state;
	ui.session.cancelToolCall?.(state.focusedCallId, entry.name);
	return state;
}
