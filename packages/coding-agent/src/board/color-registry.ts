/**
 * Color identity and registry for agents — ported from tangle/visual/color.go.
 *
 * Each agent gets a unique color identity from the 12x12 palette.
 * The registry prevents collisions and supports preference-based assignment.
 */

import { PALETTE, type PaletteColor, type Shade } from "./palette.js";

// ---------------------------------------------------------------------------
// Agent color identity
// ---------------------------------------------------------------------------

export interface AgentColor {
	/** Color family: "red", "blue", etc. */
	family: string;
	/** Shade within family: "crimson", "azure", etc. */
	shade: string;
	/** Display name (= shade name) */
	name: string;
	/** Agent function: "worker", "reviewer", "scout", etc. */
	role: string;
	/** The contract/forum this agent belongs to */
	collective: string;
	/** CSS hex: "#DC143C" */
	hex: string;
}

/** Heraldic title: "Denim Worker of Indigo Refactor" */
export function colorTitle(c: AgentColor): string {
	return `${c.name} ${c.role} of ${c.shade} ${c.collective}`;
}

/** Compact log label: "[Indigo·Denim|Worker]" */
export function colorLabel(c: AgentColor): string {
	return `[${c.shade}·${c.name}|${c.role}]`;
}

/** Short name: "Denim" */
export function colorShort(c: AgentColor): string {
	return c.name;
}

/** ANSI 24-bit true color escape for foreground text */
export function colorAnsi(c: AgentColor): string {
	if (c.hex.length !== 7) return "";
	const r = Number.parseInt(c.hex.slice(1, 3), 16);
	const g = Number.parseInt(c.hex.slice(3, 5), 16);
	const b = Number.parseInt(c.hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** ANSI reset */
export const ANSI_RESET = "\x1b[0m";

/** Color preference for assignment (not a commitment) */
export interface ColorReservation {
	shade?: string; // preferred shade family (empty = any)
	color?: string; // preferred color (empty = any in shade)
}

// ---------------------------------------------------------------------------
// Palette lookup
// ---------------------------------------------------------------------------

export function lookupShade(name: string): Shade | undefined {
	return PALETTE.find((s) => s.name === name);
}

export function lookupColor(name: string): { color: PaletteColor; shade: string } | undefined {
	for (const shade of PALETTE) {
		for (const color of shade.colors) {
			if (color.name === name) {
				return { color, shade: shade.name };
			}
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Registry — prevents color collisions
// ---------------------------------------------------------------------------

export class ColorRegistry {
	private assigned = new Map<string, AgentColor>();

	private key(shade: string, color: string): string {
		return `${shade}·${color}`;
	}

	/** Assign a random available color */
	assign(role: string, collective: string): AgentColor {
		// Shuffle shades for even distribution
		const shadeIndices = Array.from({ length: PALETTE.length }, (_, i) => i);
		shuffle(shadeIndices);

		for (const si of shadeIndices) {
			const shade = PALETTE[si];
			for (const color of shade.colors) {
				const k = this.key(shade.name, color.name);
				if (!this.assigned.has(k)) {
					const agent: AgentColor = {
						family: shade.name,
						shade: color.name,
						name: color.name,
						role,
						collective,
						hex: color.hex,
					};
					this.assigned.set(k, agent);
					return agent;
				}
			}
		}
		throw new Error("All color slots are assigned");
	}

	/** Assign from a specific shade family */
	assignInGroup(shadeName: string, role: string, collective: string): AgentColor {
		const shade = lookupShade(shadeName);
		if (!shade) throw new Error(`Unknown shade: "${shadeName}"`);

		for (const color of shade.colors) {
			const k = this.key(shade.name, color.name);
			if (!this.assigned.has(k)) {
				const agent: AgentColor = {
					family: shade.name,
					shade: color.name,
					name: color.name,
					role,
					collective,
					hex: color.hex,
				};
				this.assigned.set(k, agent);
				return agent;
			}
		}
		throw new Error(`All colors in shade "${shadeName}" are assigned`);
	}

	/** Try preference first, fall back to group, then any */
	assignWithPreference(reservation: ColorReservation, role: string, collective: string): AgentColor {
		if (reservation.shade && reservation.color) {
			try {
				return this.set(reservation.shade, reservation.color, role, collective);
			} catch {
				// Preferred color taken — fall through
			}
		}
		if (reservation.shade) {
			return this.assignInGroup(reservation.shade, role, collective);
		}
		return this.assign(role, collective);
	}

	/** Explicitly assign a specific shade+color */
	set(shadeName: string, colorName: string, role: string, collective: string): AgentColor {
		const found = lookupColor(colorName);
		if (!found) throw new Error(`Unknown color: "${colorName}"`);
		if (found.shade !== shadeName) {
			throw new Error(`Color "${colorName}" belongs to shade "${found.shade}", not "${shadeName}"`);
		}

		const k = this.key(shadeName, colorName);
		if (this.assigned.has(k)) {
			throw new Error(`Color already assigned: ${shadeName}·${colorName}`);
		}

		const agent: AgentColor = {
			family: found.shade,
			shade: found.color.name,
			name: found.color.name,
			role,
			collective,
			hex: found.color.hex,
		};
		this.assigned.set(k, agent);
		return agent;
	}

	/** Release a color back to the pool */
	release(c: AgentColor): void {
		this.assigned.delete(this.key(c.family, c.name));
	}

	/** Get a color by name (if assigned) */
	get(colorName: string): AgentColor | undefined {
		for (const agent of this.assigned.values()) {
			if (agent.name === colorName) return agent;
		}
		return undefined;
	}

	/** Number of currently assigned colors */
	get active(): number {
		return this.assigned.size;
	}

	/** All currently assigned colors */
	getAll(): AgentColor[] {
		return [...this.assigned.values()];
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shuffle<T>(arr: T[]): void {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
}

/** Reserved color for the General Secretary */
export const GENSEC_COLOR: AgentColor = {
	family: "black",
	shade: "onyx",
	name: "onyx",
	role: "secretary",
	collective: "system",
	hex: "#353839",
};
