/**
 * InputPattern — configurable leader-key dispatch for user input.
 *
 * Three built-in patterns:
 *   command    : (colon)   beginning-of-input   → command registry
 *   filesystem / (slash)   beginning-of-input   → slash command aliases
 *   message    @ (at)      beginning-of-input   → actor routing
 *
 * Organ developers can register new patterns via contributions.
 * Users can remap leader keys via config.
 */

export type DetectionRule = "beginning" | "anywhere";

export interface InputPattern {
	name: string;
	leader: string;
	detection: DetectionRule;
	description: string;
	handle: (text: string, remainder: string) => boolean | Promise<boolean>;
}

export class InputPatternRegistry {
	private readonly _patterns: InputPattern[] = [];

	register(pattern: InputPattern): this {
		const existing = this._patterns.findIndex((p) => p.name === pattern.name);
		if (existing >= 0) this._patterns[existing] = pattern;
		else this._patterns.push(pattern);
		return this;
	}

	remap(name: string, leader: string): this {
		const p = this._patterns.find((p) => p.name === name);
		if (p) p.leader = leader;
		return this;
	}

	async dispatch(text: string): Promise<boolean> {
		for (const pattern of this._patterns) {
			if (pattern.detection === "beginning" && text.startsWith(pattern.leader)) {
				const remainder = text.slice(pattern.leader.length).trim();
				const handled = await pattern.handle(text, remainder);
				if (handled) return true;
			}
			if (pattern.detection === "anywhere" && text.includes(pattern.leader)) {
				const handled = await pattern.handle(text, text);
				if (handled) return true;
			}
		}
		return false;
	}

	list(): readonly InputPattern[] {
		return this._patterns;
	}
}
