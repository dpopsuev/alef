import type { Component } from "../component.js";
import { getKeybindings } from "../keybindings.js";
import { Loader } from "./loader.js";

/**
 * Behavioural middleware: wraps content with a cancel-on-Escape lifecycle.
 * When content is provided, renders the content + a cancel hint.
 * When no content, renders as a standard spinner (Loader).
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.setContent(someComponent);
 * loader.onAbort = () => cleanup();
 * doWork(loader.signal).then(done);
 */
export class CancellableLoader extends Loader {
	private abortController = new AbortController();
	private wrappedContent: Component | undefined;

	onAbort?: () => void;

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	get aborted(): boolean {
		return this.abortController.signal.aborted;
	}

	setContent(content: Component): void {
		this.wrappedContent = content;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.abortController.abort();
			this.onAbort?.();
		}
	}

	render(width: number): string[] {
		if (this.aborted) return [];
		if (this.wrappedContent) {
			return [...this.wrappedContent.render(width), ...super.render(width)];
		}
		return super.render(width);
	}

	invalidate(): void {
		this.wrappedContent?.invalidate();
	}

	dispose(): void {
		this.stop();
	}
}
