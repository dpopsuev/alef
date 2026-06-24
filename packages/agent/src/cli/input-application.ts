import type { Component } from "@dpopsuev/alef-tui";

/**
 * InputApplication — protocol for applications hosted in the input zone.
 *
 * The input zone is a mode-switchable application slot. The default mode
 * is the prompt editor. :commands launch applications that take over
 * the input zone with their own rendering and keybindings.
 *
 * Lifecycle:
 *   :session → InputApplication.mount() → renders in input zone
 *   user interacts → handleInput() routes keys to the application
 *   Esc or result → onDismiss(result) → returns to prompt editor
 *
 * Composition:
 *   ┌──────────────────────────────┐
 *   │  INPUT ZONE                  │
 *   │  ┌────────────────────────┐  │
 *   │  │ active application     │  │  ← InputApplication.render()
 *   │  │ (editor / picker / app)│  │
 *   │  ├────────────────────────┤  │
 *   │  │ reactive sub-elements  │  │  ← autocomplete, hints, etc.
 *   │  └────────────────────────┘  │
 *   └──────────────────────────────┘
 */

export interface InputApplicationResult {
	/** Value returned to the prompt or action system. */
	value?: string;
	/** Action to take (e.g. "switch-session", "select-blueprint"). */
	action?: string;
}

export interface InputApplication {
	/** Unique name for this application. */
	readonly name: string;

	/** Component that renders in the input zone. */
	readonly view: Component;

	/** Called when the application is mounted into the input zone. */
	onMount?(): void;

	/**
	 * Called when the application is dismissed.
	 * Return a result to feed back into the prompt or trigger an action.
	 */
	onDismiss?(): InputApplicationResult | undefined;
}

export type InputApplicationFactory = (args: string) => InputApplication | undefined;

/**
 * Registry of :command → InputApplication factories.
 *
 * Usage:
 *   registry.register("session", (args) => new SessionPickerApp());
 *   registry.register("blueprint", (args) => new BlueprintPickerApp());
 *
 *   const app = registry.resolve("session");
 *   if (app) inputZone.activate(app);
 */
export class InputApplicationRegistry {
	private readonly factories = new Map<string, InputApplicationFactory>();

	register(command: string, factory: InputApplicationFactory): void {
		this.factories.set(command, factory);
	}

	resolve(command: string, args = ""): InputApplication | undefined {
		const factory = this.factories.get(command);
		return factory?.(args);
	}

	list(): string[] {
		return [...this.factories.keys()];
	}
}
