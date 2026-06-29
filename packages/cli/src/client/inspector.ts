import type { TuiState, TuiUi } from "./state.js";

const INSPECTOR_LINES = 12;
const INSPECTOR_SCROLL_STEP = 3;

export function renderChunkWindow(chunks: string[], scrollOffset: number): string {
	const all = chunks.join("").split("\n");
	const end = Math.max(0, all.length - scrollOffset);
	const start = Math.max(0, end - INSPECTOR_LINES);
	return all.slice(start, end).join("\n");
}

export function updateInspectorView(state: TuiState, ui: TuiUi, callId: string | null, scrollOffset = 0): void {
	ui.promptConsole.setFocusedCall(callId);
	if (callId && state.callChunks.has(callId)) {
		const chunks = state.callChunks.get(callId) ?? [];
		ui.promptConsole.setChunkText(renderChunkWindow(chunks, scrollOffset));
	} else {
		ui.promptConsole.setChunkText("");
	}
}

export function handleInspectorCycle(state: TuiState, ui: TuiUi): TuiState {
	if (state.activeCalls.size === 0) return state;
	const ids = [...state.activeCalls.keys()];
	const idx = state.focusedCallId ? ids.indexOf(state.focusedCallId) : -1;
	const nextId = ids[(idx + 1) % ids.length];
	updateInspectorView(state, ui, nextId, state.inspectorScrollOffset);
	return { ...state, focusedCallId: nextId };
}

export function handleInspectorClose(state: TuiState, ui: TuiUi): TuiState {
	updateInspectorView(state, ui, null);
	return { ...state, focusedCallId: null, inspectorScrollOffset: 0 };
}

export function handleInspectorScroll(state: TuiState, ui: TuiUi, direction: -1 | 1): TuiState {
	if (!state.focusedCallId) return state;
	const chunks = state.callChunks.get(state.focusedCallId) ?? [];
	const totalLines = chunks.join("").split("\n").length;
	const maxScroll = Math.max(0, totalLines - INSPECTOR_LINES);
	const next = Math.max(0, Math.min(maxScroll, state.inspectorScrollOffset + direction * INSPECTOR_SCROLL_STEP));
	ui.promptConsole.setChunkText(renderChunkWindow(chunks, next));
	return { ...state, inspectorScrollOffset: next };
}

export function handleInspectorCancel(state: TuiState, ui: TuiUi): TuiState {
	if (!state.focusedCallId) return state;
	const entry = state.activeCalls.get(state.focusedCallId);
	if (!entry) return state;
	ui.session.cancelToolCall?.(state.focusedCallId, entry.name);
	return state;
}
