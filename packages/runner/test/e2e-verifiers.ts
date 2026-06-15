/**
 * E2E verifier functions — assertion logic for each real-LLM scenario.
 *
 * Each function is a pure assertion: takes fixture data, throws on failure.
 * No LLM, no process spawning, no I/O.
 *
 * Usage pattern (mirrors pivi):
 *   1. Self-test each verifier against a known-good fixture in e2e-verifier.test.ts
 *      (always CI, no LLM gate — proves the checker is correct).
 *   2. Call the same verifier inside the real-LLM test
 *      (gated on ANTHROPIC_API_KEY — proves the agent behaves correctly).
 *
 * If an assertion fails in CI, the checker is broken.
 * If an assertion fails only with a real LLM, the agent behavior changed.
 */

export interface ToolRecord {
	type: string;
	bus: "motor" | "sense" | "signal" | "internal";
	hash?: string;
}

// ---------------------------------------------------------------------------
// E2E-184: file read workflow
// ---------------------------------------------------------------------------

/**
 * Assert that the agent read a file and reported the secret in its reply.
 * Accepts either fs.read or lector.read — both are valid file read strategies.
 */
export function assertFileReadWorkflow(records: ToolRecord[], replyText: string, secret: string): void {
	const types = new Set(records.map((r) => r.type));
	if (!types.has("fs.read") && !types.has("lector.read")) {
		throw new Error(
			`verifier: expected fs.read or lector.read in JSONL, got: ${[...types].filter((t) => !t.includes("dialog")).join(", ") || "(none)"}`,
		);
	}
	if (!replyText.includes(secret)) {
		throw new Error(`verifier: reply does not contain secret '${secret}'. Reply: ${replyText.slice(0, 200)}`);
	}
}

/**
 * Assert every StorageRecord has a SHA-256 hash (audit integrity).
 */
export function assertHashesPresent(records: ToolRecord[]): void {
	const missing = records.filter((r) => r.bus !== "internal" && typeof r.hash !== "string").length;
	if (missing > 0) {
		throw new Error(`verifier: ${missing} non-internal record(s) missing hash field`);
	}
}

// ---------------------------------------------------------------------------
// E2E-185: blueprint organ selection
// ---------------------------------------------------------------------------

/**
 * Assert that required tool types appear in JSONL and forbidden prefixes do not.
 * required: exact type strings that must be present.
 * forbiddenPrefixes: event type prefixes (e.g. "lector.", "shell.") that must be absent.
 */
export function assertOrganSelection(records: ToolRecord[], required: string[], forbiddenPrefixes: string[]): void {
	const types = new Set(records.map((r) => r.type));
	for (const req of required) {
		if (!types.has(req)) {
			throw new Error(`verifier: required event type '${req}' not found in JSONL`);
		}
	}
	for (const prefix of forbiddenPrefixes) {
		const found = [...types].find((t) => t.startsWith(prefix));
		if (found) {
			throw new Error(`verifier: forbidden event '${found}' (prefix: '${prefix}') found in JSONL`);
		}
	}
}

// ---------------------------------------------------------------------------
// E2E-187: SSE surface filter
// ---------------------------------------------------------------------------

/**
 * Assert SSE filter correctness:
 *   - allowedOnSse: must appear in SSE events
 *   - blockedFromSse: must NOT appear in SSE events, but MUST appear in JSONL
 *     (proves the tool was called but the surface filter worked)
 */
export function assertSseFilter(
	sseEventTypes: string[],
	jsonlTypes: Set<string>,
	allowedOnSse: string[],
	blockedFromSse: string[],
): void {
	for (const t of allowedOnSse) {
		if (!sseEventTypes.includes(t)) {
			throw new Error(`verifier: '${t}' must appear on SSE but was absent`);
		}
	}
	for (const t of blockedFromSse) {
		if (sseEventTypes.includes(t)) {
			throw new Error(`verifier: '${t}' must NOT appear on SSE (surface filter broken)`);
		}
		if (!jsonlTypes.has(t)) {
			throw new Error(`verifier: '${t}' absent from JSONL — tool was never called, surface filter was not needed`);
		}
	}
}

// ---------------------------------------------------------------------------
// E2E-186: tool call sequence
// ---------------------------------------------------------------------------

/**
 * Assert that motor events appear in the given order (subsequence check).
 * Does not require the sequence to be contiguous — only that each element
 * appears after the previous one.
 *
 * sequence: ["lector.read", "lector.edit"] means lector.read must precede
 * lector.edit somewhere in the motor event stream.
 */
export function assertToolSequence(records: ToolRecord[], sequence: string[]): void {
	const motorTypes = records.filter((r) => r.bus === "motor").map((r) => r.type);
	let cursor = 0;
	for (const expected of sequence) {
		const slice = motorTypes.slice(cursor);
		const idx = slice.indexOf(expected);
		if (idx === -1) {
			throw new Error(
				`verifier: tool sequence broken — expected '${expected}' at or after position ${cursor}. ` +
					`Motor stream: [${motorTypes.join(" → ")}]`,
			);
		}
		cursor += idx + 1;
	}
}

// ---------------------------------------------------------------------------
// E2E-189: multi-turn history
// ---------------------------------------------------------------------------

/**
 * Assert that the agent carried the secret across turns.
 * Both replies must contain the secret — turn 2 proves history retention.
 */
export function assertMultiTurnHistory(reply1: string, reply2: string, secret: string): void {
	if (!reply1.includes(secret)) {
		throw new Error(`verifier: turn 1 reply does not contain secret '${secret}'. Reply: ${reply1.slice(0, 200)}`);
	}
	if (!reply2.includes(secret)) {
		throw new Error(
			`verifier: turn 2 reply does not contain secret from turn 1. Secret: '${secret}'. Reply: ${reply2.slice(0, 200)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// E2E-188: web fetch
// ---------------------------------------------------------------------------

/**
 * Assert the agent reported the expected content from a web fetch.
 */
export function assertWebFetch(reply: string, expectedPattern: RegExp): void {
	if (!expectedPattern.test(reply)) {
		throw new Error(
			`verifier: reply does not match expected pattern ${expectedPattern}. Reply: ${reply.slice(0, 200)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// E2E-subagent: outer agent delegates via agent.run, inner agent reads file
// ---------------------------------------------------------------------------

/**
 * Assert that the outer agent delegated to a subagent (agent.run in motor events)
 * and the final reply contains the secret retrieved by the inner agent.
 *
 * The inner agent's fs.read calls are in-process and do not appear in the outer
 * JSONL session store — only agent.run on the outer motor bus is observable.
 * The presence of the secret in the reply is the end-to-end proof that the full
 * delegation chain worked: outer LLM → agent.run → inner LLM → fs.read → reply.
 */
export function assertSubagentWorkflow(records: ToolRecord[], replyText: string, secret: string): void {
	const motorTypes = records.filter((r) => r.bus === "motor").map((r) => r.type);
	if (!motorTypes.includes("agent.run")) {
		throw new Error(
			`verifier: expected agent.run in motor events — outer LLM did not delegate. ` +
				`Motor stream: [${motorTypes.join(", ") || "(empty)"}]`,
		);
	}
	if (!replyText.includes(secret)) {
		throw new Error(
			`verifier: reply does not contain secret '${secret}' — inner agent did not retrieve it. ` +
				`Reply: ${replyText.slice(0, 200)}`,
		);
	}
}
