/**
 * ChannelManager — swappable chat log sources for the TUI.
 *
 * The default channel is the main conversation (human ↔ root agent).
 * Additional channels map to forum topics or agent-specific views.
 * Switching channels swaps which Container is visible in the TUI tree.
 *
 * Usage:
 *   @              → list available channels
 *   @general       → switch view to the 'general' channel
 *   @general msg   → post to 'general' without switching
 */

import { Container, Text } from "@dpopsuev/alef-tui";

export class ChannelManager {
	private readonly channels = new Map<string, Container>();
	private activeChannel = "main";
	private readonly parent: Container;

	constructor(parent: Container, mainChat: Container) {
		this.parent = parent;
		this.channels.set("main", mainChat);
	}

	get active(): string {
		return this.activeChannel;
	}

	/** Get or create a channel's Container. */
	getOrCreate(name: string): Container {
		let container = this.channels.get(name);
		if (!container) {
			container = new Container();
			container.addChild(new Text(`[channel: ${name}]`, 0, 0));
			this.channels.set(name, container);
		}
		return container;
	}

	/** Switch the visible channel. Returns the newly active Container. */
	switchTo(name: string): Container {
		const target = this.getOrCreate(name);
		const current = this.channels.get(this.activeChannel);

		if (current && current !== target) {
			this.parent.removeChild(current);
			this.parent.addChild(target);
		}

		this.activeChannel = name;
		return target;
	}

	/** Get the currently visible Container. */
	current(): Container {
		return this.channels.get(this.activeChannel) ?? this.channels.get("main") ?? new Container();
	}

	/** List all channel names. */
	list(): string[] {
		return [...this.channels.keys()];
	}
}
