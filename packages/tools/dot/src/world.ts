/**
 * Dot-in-circle pure plant — no Alef imports.
 */

/** Episode status for the plant. */
export type DotStatus = "ok" | "game_over";

/** Serialisable snapshot of plant state. */
export interface DotSnapshot {
	readonly x: number;
	readonly y: number;
	readonly radius: number;
	readonly dist: number;
	readonly inside: boolean;
	readonly status: DotStatus;
	readonly tick: number;
}

/** Constructor options for DotWorld. */
export interface DotWorldOptions {
	readonly radius?: number;
	readonly force?: number;
	readonly seed?: number;
	readonly moveMax?: number;
}

/** Deterministic PRNG — mulberry32. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Clamp a number into [min, max]. */
function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * Dot-in-circle physics: seeded random drift is the disturbance;
 * agent `move` is the control impulse. Turn order: move then drift.
 * Leaving |p| > R sets status to game_over.
 */
export class DotWorld {
	readonly radius: number;
	readonly force: number;
	readonly moveMax: number;

	private x = 0;
	private y = 0;
	private tick = 0;
	private status: DotStatus = "ok";
	private seed: number;
	private random: () => number;

	constructor(opts: DotWorldOptions = {}) {
		this.radius = opts.radius ?? 5;
		this.force = opts.force ?? 2.5;
		this.moveMax = opts.moveMax ?? 2;
		this.seed = opts.seed ?? 1;
		this.random = mulberry32(this.seed);
	}

	/** Reset to origin with an optional new seed. */
	reset(seed?: number): DotSnapshot {
		this.seed = seed ?? this.seed;
		this.random = mulberry32(this.seed);
		this.x = 0;
		this.y = 0;
		this.tick = 0;
		this.status = "ok";
		return this.snapshot();
	}

	/** Current plant snapshot. */
	snapshot(): DotSnapshot {
		const dist = Math.hypot(this.x, this.y);
		const inside = dist <= this.radius;
		return {
			x: this.x,
			y: this.y,
			radius: this.radius,
			dist,
			inside,
			status: this.status,
			tick: this.tick,
		};
	}

	/** Control impulse only (no drift). */
	applyMove(dx: number, dy: number): void {
		if (this.status === "game_over") return;
		this.x += clamp(dx, -this.moveMax, this.moveMax);
		this.y += clamp(dy, -this.moveMax, this.moveMax);
		this.evaluateBoundary();
	}

	/** One seeded drift tick. */
	tickDrift(): DotSnapshot {
		if (this.status === "game_over") return this.snapshot();
		const dx = (this.random() * 2 - 1) * this.force;
		const dy = (this.random() * 2 - 1) * this.force;
		this.x += dx;
		this.y += dy;
		this.tick += 1;
		this.evaluateBoundary();
		return this.snapshot();
	}

	/** Agent control then one drift tick. */
	move(dx: number, dy: number): DotSnapshot {
		this.applyMove(dx, dy);
		if (this.status === "game_over") return this.snapshot();
		return this.tickDrift();
	}

	private evaluateBoundary(): void {
		if (Math.hypot(this.x, this.y) > this.radius) {
			this.status = "game_over";
		}
	}
}
