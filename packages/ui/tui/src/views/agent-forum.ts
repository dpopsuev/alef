/**
 * AgentForum — swappable chat log sources for the TUI.
 *
 * The default forum is the main conversation (human ↔ root agent).
 * Additional forums map to forum topics or agent-specific views.
 * Switching forums swaps which Container is visible in the TUI tree.
 *
 * Usage:
 *   @              → list available forums
 *   @general       → switch view to the 'general' forum
 *   @general msg   → post to 'general' without switching
 */

import { Text } from "../components/text.js";
import { Container } from "../tui.js";

/**
 *
 */
export class AgentForum {
	private readonly forums = new Map<string, Container>();
	private activeForum = "main";
	private readonly parent: Container;

	constructor(parent: Container, mainChat: Container) {
		this.parent = parent;
		this.forums.set("main", mainChat);
	}

	get active(): string {
		return this.activeForum;
	}

	/** Get or create a forum's Container. */
	getOrCreate(name: string): Container {
		let container = this.forums.get(name);
		if (!container) {
			container = new Container();
			container.addChild(new Text(`[forum: ${name}]`, 0, 0));
			this.forums.set(name, container);
		}
		return container;
	}

	/** Switch the visible forum. Returns the newly active Container. */
	switchTo(name: string): Container {
		const target = this.getOrCreate(name);
		const current = this.forums.get(this.activeForum);

		if (current && current !== target) {
			this.parent.removeChild(current);
			this.parent.addChild(target);
		}

		this.activeForum = name;
		return target;
	}

	/** Get the currently visible Container. */
	current(): Container {
		return this.forums.get(this.activeForum) ?? this.forums.get("main") ?? new Container();
	}

	/** List all forum names. */
	list(): string[] {
		return [...this.forums.keys()];
	}
}
