/**
 * Decaying event pressure gauge.
 *
 * Each pulse() call (token received, tool call, thinking chunk) raises the
 * pressure level. Pressure decays exponentially toward zero between pulses.
 *
 * level() returns 0.0 (idle) → 1.0 (maximum load).
 */
export class EventPressure {
	private value = 0;
	private lastDecayAt = Date.now();

	constructor(
		private readonly halfLifeMs = 600,
		private readonly pulseStrength = 0.25,
	) {}

	pulse(): void {
		this.applyDecay();
		this.value = Math.min(1, this.value + this.pulseStrength);
	}

	level(): number {
		this.applyDecay();
		return Math.max(0, Math.min(1, this.value));
	}

	private applyDecay(): void {
		const now = Date.now();
		const elapsed = now - this.lastDecayAt;
		this.value *= Math.exp((-elapsed * Math.LN2) / this.halfLifeMs);
		this.lastDecayAt = now;
	}
}

/**
 * Map a pressure level (0–1) to a spinner tick interval in ms.
 * Idle → slowMs, saturated → fastMs.
 */
export function pressureToInterval(level: number, slowMs = 80, fastMs = 28): number {
	return Math.round(slowMs - level * (slowMs - fastMs));
}

/**
 * Compute spinner hue for a given elapsed time and pressure level.
 *
 * The hue rotates continuously through the full 360° wheel over `cyclePeriodMs`
 * at idle. Pressure multiplies the rotation rate (more activity → faster spin)
 * and also adds a forward boost so busy turns visibly accelerate.
 *
 * Formula:
 *   baseRate  = 1 full rotation per cyclePeriodMs
 *   speedMult = 1 + pressure × pressureSpeedBoost   (1× idle, 4× saturated)
 *   hue       = (elapsedMs × baseRate × speedMult × 360) % 360
 */
export function timeBasedHue(
	elapsedMs: number,
	pressureLevel: number,
	cyclePeriodMs = 3500,
	pressureSpeedBoost = 3,
): number {
	const baseRate = 1 / cyclePeriodMs; // rotations per ms
	const speedMult = 1 + pressureLevel * pressureSpeedBoost;
	return (elapsedMs * baseRate * speedMult * 360) % 360;
}
