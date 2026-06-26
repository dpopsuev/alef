const DEFAULT_WEIGHT = 0.5;

const weights = new Map<string, number>();

export function registerEventWeights(contributed: Readonly<Record<string, number>>): void {
	for (const [type, weight] of Object.entries(contributed)) {
		weights.set(type, weight);
	}
}

export function eventTypeWeight(type: string): number {
	return weights.get(type) ?? DEFAULT_WEIGHT;
}

export function extractContentLength(payload: Record<string, unknown>): number {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped display payload field
	const display = (payload._display as { text?: string } | undefined)?.text;
	if (typeof display === "string") return display.length;
	if (typeof payload.content === "string") return payload.content.length;
	if (typeof payload.text === "string") return payload.text.length;
	if (typeof payload.output === "string") return payload.output.length;
	const { _display: _d, toolCallId: _t, isFinal: _f, usage: _u, ...rest } = payload;
	return JSON.stringify(rest).length;
}
