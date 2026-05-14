import { PALETTE, type PaletteColor, type Shade } from "./palette.js";

export interface AgentColor {
	family: string;
	shade: string;
	name: string;
	role: string;
	collective: string;
	hex: string;
}

export function colorTitle(c: AgentColor): string {
	return `${c.name} ${c.role} of ${c.shade} ${c.collective}`;
}

export function colorLabel(c: AgentColor): string {
	return `[${c.shade}·${c.name}|${c.role}]`;
}

export function colorShort(c: AgentColor): string {
	return c.name;
}

export function colorAnsi(c: AgentColor): string {
	if (c.hex.length !== 7) return "";
	const r = Number.parseInt(c.hex.slice(1, 3), 16);
	const g = Number.parseInt(c.hex.slice(3, 5), 16);
	const b = Number.parseInt(c.hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

export const ANSI_RESET = "\x1b[0m";

export interface ColorReservation {
	shade?: string;
	color?: string;
}

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

export class ColorRegistry {
	private assigned = new Map<string, AgentColor>();

	private key(shade: string, color: string): string {
		return `${shade}·${color}`;
	}

	assign(role: string, collective: string): AgentColor {
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

	assignWithPreference(reservation: ColorReservation, role: string, collective: string): AgentColor {
		if (reservation.shade && reservation.color) {
			try {
				return this.set(reservation.shade, reservation.color, role, collective);
			} catch {
				return this.assignInGroup(reservation.shade, role, collective);
			}
		}
		if (reservation.shade) {
			return this.assignInGroup(reservation.shade, role, collective);
		}
		return this.assign(role, collective);
	}

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

	release(c: AgentColor): void {
		this.assigned.delete(this.key(c.family, c.name));
	}

	get(colorName: string): AgentColor | undefined {
		for (const agent of this.assigned.values()) {
			if (agent.name === colorName) return agent;
		}
		return undefined;
	}

	get active(): number {
		return this.assigned.size;
	}

	getAll(): AgentColor[] {
		return [...this.assigned.values()];
	}
}

function shuffle<T>(arr: T[]): void {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
}

export const COORDINATOR_COLOR: AgentColor = {
	family: "blue",
	shade: "cobalt",
	name: "cobalt",
	role: "coordinator",
	collective: "system",
	hex: "#0047AB",
};

export const GENSEC_COLOR: AgentColor = {
	family: "black",
	shade: "onyx",
	name: "onyx",
	role: "secretary",
	collective: "system",
	hex: "#353839",
};
