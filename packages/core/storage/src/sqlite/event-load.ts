/**
 * Bounded event loading for resume warm + session-picker preview.
 * Fat rows (context.assemble, llm.checkpoint, …) must not JSON.parse into OOM.
 */

/** Match prior warm window; SQL filters shrink the effective set. */
export const MAX_WARM_EVENTS = 50_000;

/** Payloads larger than this become stubs instead of full JSON.parse. */
export const MAX_PAYLOAD_BYTES = 512_000;

/** Types that may exceed MAX_PAYLOAD_BYTES and still be parsed (dialog text). */
const ALLOW_LARGE_PAYLOAD_TYPES = new Set(["llm.input", "llm.response", "llm.result"]);

/**
 * Warm/resume: keep command/event/internal dialog + tools; drop assemble noise,
 * streaming chunks, and TUI/bus auto-trace mirrors.
 */
export const WARM_EVENT_SQL_FILTER = `
	bus IN ('command', 'event', 'internal')
	AND type NOT IN (
		'context.assemble',
		'llm.chunk',
		'llm.thinking',
		'llm.tool-chunk',
		'llm.tool-progress'
	)
	AND type NOT LIKE 'tui:%'
	AND type NOT LIKE 'bus:%'
`;

/**
 * Preview/transcript: only rows projectRecord can turn into chat blocks.
 */
export const PREVIEW_EVENT_SQL_FILTER = `
	(
		(bus = 'event' AND type = 'llm.input')
		OR (bus = 'command' AND type = 'llm.response')
		OR (bus = 'notification' AND type = 'llm.result')
		OR (type = 'context.injection')
		OR (
			bus = 'command'
			AND type NOT LIKE 'llm.%'
			AND type NOT LIKE 'context.%'
		)
	)
`;

/**
 *
 */
export function parseEventPayload(raw: string, type: string): Record<string, unknown> {
	if (raw.length > MAX_PAYLOAD_BYTES && !ALLOW_LARGE_PAYLOAD_TYPES.has(type)) {
		return { _truncated: true, _bytes: raw.length, _type: type };
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload stored as JSON object
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return { _parseError: true, _bytes: raw.length, _type: type };
	}
}

const PREVIEW_EVENTS_PER_TURN = 32;
const PREVIEW_EVENT_LIMIT_MIN = 200;

/** Event fetch window for turn-bounded preview (matches projector heuristic × headroom). */
export function previewEventLimit(maxTurns: number): number {
	const turns = Math.max(1, maxTurns);
	return Math.max(turns * PREVIEW_EVENTS_PER_TURN, PREVIEW_EVENT_LIMIT_MIN);
}
