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
export function pressureToInterval(level: number, slowMs = 160, fastMs = 55): number {
	return Math.round(slowMs - level * (slowMs - fastMs));
}

/**
 * Map a pressure level (0–1) to an HSL hue offset in degrees.
 * Used to shift the spinner color away from the base accent hue.
 */
export function pressureToHueShift(level: number, maxDegrees = 80): number {
	return level * maxDegrees;
}
