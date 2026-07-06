/**
 * Constraint-based layout solver — Ratatui-style.
 *
 * Divides available space into regions based on constraints:
 *   Min(n)        — at least n cells
 *   Max(n)        — at most n cells
 *   Length(n)     — exactly n cells
 *   Percentage(n) — n% of available space
 *   Fill          — takes remaining space after fixed allocations
 *
 * Usage:
 *   const regions = solveConstraints(
 *     [Length(3), Fill, Percentage(20), Min(5)],
 *     terminalWidth,
 *   );
 *   // regions = [3, 154, 46, 27]  (for width=230)
 */

/**
 *
 */
export type Constraint =
	| { type: "min"; value: number }
	| { type: "max"; value: number }
	| { type: "length"; value: number }
	| { type: "percentage"; value: number }
	| { type: "fill" };

export const Min = (value: number): Constraint => ({ type: "min", value });
export const Max = (value: number): Constraint => ({ type: "max", value });
export const Length = (value: number): Constraint => ({ type: "length", value });
export const Percentage = (value: number): Constraint => ({ type: "percentage", value });
export const Fill: Constraint = { type: "fill" };

/**
 *
 */
export function solveConstraints(constraints: readonly Constraint[], available: number): number[] {
	const sizes = new Array<number>(constraints.length).fill(0);
	let remaining = available;

	for (let i = 0; i < constraints.length; i++) {
		const c = constraints[i];
		switch (c.type) {
			case "length":
				sizes[i] = Math.min(c.value, remaining);
				remaining -= sizes[i];
				break;
			case "percentage":
				sizes[i] = Math.min(Math.floor((c.value / 100) * available), remaining);
				remaining -= sizes[i];
				break;
			case "min":
				sizes[i] = Math.min(c.value, remaining);
				remaining -= sizes[i];
				break;
			case "max":
				sizes[i] = 0;
				break;
			case "fill":
				break;
		}
	}

	const fillIndices = constraints
		.map((c, i) => (c.type === "fill" ? i : -1))
		.filter((i) => i >= 0);

	if (fillIndices.length > 0 && remaining > 0) {
		const perFill = Math.floor(remaining / fillIndices.length);
		for (const i of fillIndices) {
			sizes[i] = perFill;
		}
		remaining -= perFill * fillIndices.length;
		if (remaining > 0) sizes[fillIndices[0]] += remaining;
	} else if (remaining > 0 && fillIndices.length === 0) {
		sizes[sizes.length - 1] += remaining;
	}

	for (let i = 0; i < constraints.length; i++) {
		const c = constraints[i];
		if (c.type === "min") sizes[i] = Math.max(sizes[i], c.value);
		if (c.type === "max") sizes[i] = Math.min(sizes[i] || available, c.value);
	}

	return sizes.map((s) => Math.max(0, s));
}
