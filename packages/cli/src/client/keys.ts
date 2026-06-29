import { traceEvent } from "@dpopsuev/alef-kernel/log";
import { matchesKey } from "@dpopsuev/alef-tui";
import type { TuiHandlerContext } from "./dispatch.js";
import { handleCtrlC } from "./dispatch.js";
import type { TuiEvent } from "./events.js";
import type { OverlayDescriptor, TuiState } from "./state.js";

/**
 * Handle raw keyboard input events in the TUI.
 * Returns true if the input was handled, false otherwise.
 */
export function handleRawInput(
	data: string,
	tuiState: TuiState,
	dispatch: (event: TuiEvent) => void,
	ctx: () => TuiHandlerContext,
	historyPickerToggle: () => boolean,
): boolean {
	// Ctrl+R: Toggle history picker
	if (matchesKey(data, "ctrl+r")) {
		const picker = tuiState.overlays.find((o) => o.id === "history-picker");
		if (picker) picker.handleInput?.(data);
		else historyPickerToggle();
		return true;
	}

	// Check if any overlay wants to handle the input
	const overlay = tuiState.overlays.find((o) => o.handleInput);
	if (overlay?.handleInput) {
		overlay.handleInput(data);
		return true;
	}

	// Ctrl+C: Interrupt or quit
	if (matchesKey(data, "ctrl+c")) {
		traceEvent("raw:ctrl+c");
		handleCtrlC(ctx());
		return true;
	}

	// Ctrl+T: Toggle thinking visibility
	if (matchesKey(data, "ctrl+t")) {
		dispatch({ type: "thinking.toggle" });
		return true;
	}

	// Tab: Cycle through tool inspector when tools are active
	if (matchesKey(data, "tab") && tuiState.activeCalls.size > 0) {
		dispatch({ type: "inspector.cycle" });
		return true;
	}

	// Escape: Close tool inspector
	if (matchesKey(data, "escape") && tuiState.focusedCallId) {
		dispatch({ type: "inspector.close" });
		return true;
	}

	// Tool inspector navigation and control
	if (tuiState.focusedCallId) {
		// Ctrl+X: Cancel focused tool call
		if (matchesKey(data, "ctrl+x")) {
			dispatch({ type: "inspector.cancel" });
			return true;
		}
		// K or Up: Scroll up
		if (matchesKey(data, "k") || matchesKey(data, "up")) {
			dispatch({ type: "inspector.scroll", direction: 1 });
			return true;
		}
		// J or Down: Scroll down
		if (matchesKey(data, "j") || matchesKey(data, "down")) {
			dispatch({ type: "inspector.scroll", direction: -1 });
			return true;
		}
	}

	return false;
}

/**
 * Create an overlay descriptor for a component.
 */
export function createOverlay(
	id: string,
	component: OverlayDescriptor["component"],
	handleInput?: (data: string) => void,
): OverlayDescriptor {
	return { id, component, handleInput };
}
