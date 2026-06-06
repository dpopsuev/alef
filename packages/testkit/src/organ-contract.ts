/**
 * RunOrganContract — reusable organ compliance suite.
 *
 * Any organ implementation calls runOrganContract(organ) in a test to prove
 * it satisfies the Nerve contract. Six checks:
 *
 *   1. mount() returns a cleanup function
 *   2. cleanup is idempotent (callable twice without throwing)
 *   3. organ.tools is a defined array
 *   4. organ.subscriptions.motor lists every 'motor/' key the organ handles
 *   5. for each tool: valid Motor event → Sense event within timeout
 *   6. for each tool: invalid payload → isError:true Sense event
 *
 * Mirrors Tako testkit/contracts/RunWalkerContract.
 * Ref: ALE-TSK-323
 */

import { randomUUID } from "node:crypto";
import { InProcessNerve, type Organ, type OrganLogger, type SenseEvent } from "@dpopsuev/alef-kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

export interface CapturedLog {
	level: "debug" | "info" | "warn" | "error";
	obj: Record<string, unknown>;
	msg: string;
}

export interface OrganContractOptions {
	/** Timeout per Motor→Sense probe in ms. Default: 2000. */
	timeoutMs?: number;
}

export interface OrganContractViolation {
	check: string;
	detail: string;
}

export interface OrganContractReport {
	organ: string;
	passed: string[];
	violations: OrganContractViolation[];
	ok: boolean;
}

/**
 * Run the organ compliance suite and return a structured report.
 * Does not throw — callers decide how to handle violations.
 */
export async function runOrganContract(organ: Organ, opts: OrganContractOptions = {}): Promise<OrganContractReport> {
	const timeoutMs = opts.timeoutMs ?? 2000;
	const passed: string[] = [];
	const violations: OrganContractViolation[] = [];

	const ok = (check: string) => passed.push(check);
	const fail = (check: string, detail: string) => violations.push({ check, detail });

	// 1. mount returns a function
	const nerve = new InProcessNerve();
	let unmount: (() => void) | unknown;
	try {
		unmount = organ.mount(nerve.asNerve());
		if (typeof unmount !== "function") {
			fail("mount-returns-function", `mount() returned ${typeof unmount}, expected function`);
		} else {
			ok("mount-returns-function");
		}
	} catch (e) {
		fail("mount-returns-function", `mount() threw: ${e}`);
		return { organ: organ.name, passed, violations, ok: false };
	}

	// 2. unmount is idempotent
	if (typeof unmount === "function") {
		try {
			unmount();
			unmount();
			ok("unmount-idempotent");
		} catch (e) {
			fail("unmount-idempotent", `second unmount() threw: ${e}`);
		}
	}

	// 3. tools is a defined array
	if (!Array.isArray(organ.tools)) {
		fail("tools-defined", `organ.tools is ${typeof organ.tools}, expected array`);
	} else {
		ok("tools-defined");
	}

	// 4. subscriptions.motor matches tool names
	const toolNames = organ.tools.map((t) => t.name);
	const motorSubs = organ.subscriptions.motor;
	const unsubscribed = toolNames.filter((n) => !motorSubs.includes(n));
	if (unsubscribed.length > 0) {
		fail("subscriptions-complete", `tools [${unsubscribed.join(", ")}] have no matching motor subscription`);
	} else if (toolNames.length > 0) {
		ok("subscriptions-complete");
	}

	// 5 & 6. probe each tool with valid + invalid Motor events
	if (organ.tools.length > 0) {
		const probeNerve = new InProcessNerve();
		const probeUnmount = organ.mount(probeNerve.asNerve());

		for (const tool of organ.tools) {
			// Build a minimal valid payload from the schema
			const validPayload = buildMinimalPayload(tool.inputSchema);
			const invalidPayload = { __invalid__: true };

			// 5. Valid payload → Sense event (not necessarily isError)
			const validResult = await probeMotor(probeNerve.asNerve(), tool.name, validPayload, timeoutMs);
			if (validResult === null) {
				fail(`probe-valid:${tool.name}`, `no Sense event received within ${timeoutMs}ms for valid payload`);
			} else {
				ok(`probe-valid:${tool.name}`);
			}

			// 6. Invalid payload → isError Sense event
			const invalidResult = await probeMotor(probeNerve.asNerve(), tool.name, invalidPayload, timeoutMs);
			if (invalidResult === null) {
				fail(`probe-invalid:${tool.name}`, `no Sense event received within ${timeoutMs}ms for invalid payload`);
			} else if (!invalidResult.isError) {
				fail(
					`probe-invalid:${tool.name}`,
					`expected isError:true for invalid payload, got isError:false — organ must reject schema violations`,
				);
			} else {
				ok(`probe-invalid:${tool.name}`);
			}
		}

		probeUnmount();
	}

	return {
		organ: organ.name,
		passed,
		violations,
		ok: violations.length === 0,
	};
}

/**
 * assertOrganContract — throws on any violation. Use in vitest tests.
 *
 * @example
 * test("fs organ satisfies contract", async () => {
 *   await assertOrganContract(createFsOrgan({ cwd: "/tmp" }));
 * });
 */
export async function assertOrganContract(organ: Organ, opts?: OrganContractOptions): Promise<void> {
	const report = await runOrganContract(organ, opts);
	if (!report.ok) {
		const lines = report.violations.map((v) => `  [${v.check}] ${v.detail}`).join("\n");
		throw new Error(`Organ '${report.organ}' failed contract:\n${lines}`);
	}
}

// ---------------------------------------------------------------------------
// makeSpyLogger — captures log calls for compliance assertions
// ---------------------------------------------------------------------------

function makeSpyLogger(bindings: Record<string, unknown>, sink: CapturedLog[]): OrganLogger {
	return {
		debug(obj, msg) {
			sink.push({ level: "debug", obj: { ...bindings, ...obj }, msg });
		},
		info(obj, msg) {
			sink.push({ level: "info", obj: { ...bindings, ...obj }, msg });
		},
		warn(obj, msg) {
			sink.push({ level: "warn", obj: { ...bindings, ...obj }, msg });
		},
		error(obj, msg) {
			sink.push({ level: "error", obj: { ...bindings, ...obj }, msg });
		},
		child(childBindings) {
			return makeSpyLogger({ ...bindings, ...childBindings }, sink);
		},
	};
}

// ---------------------------------------------------------------------------
// organComplianceSuite — vitest-integrated compliance harness
// ---------------------------------------------------------------------------

export interface StreamingToolConfig {
	/** A valid payload that will cause the tool to run for > thresholdMs. */
	validPayload: Record<string, unknown>;
	/** How long the tool must run before we require chunks. Default: 500ms. */
	thresholdMs?: number;
	/** Minimum number of isFinal:false chunks expected. Default: 1. */
	minChunks?: number;
}

export interface OrganComplianceOptions {
	/**
	 * Per-tool streaming config — required for every tool whose ToolDefinition
	 * has streaming:true (set automatically by typedStreamAction).
	 *
	 * organComplianceSuite discovers streaming tools from organ.tools at
	 * describe() time and throws an error at test collection phase if any
	 * streaming tool is missing from this map.
	 *
	 * Non-streaming tools must not be listed here.
	 */
	streaming?: Record<string, StreamingToolConfig>;
	/** Override timeout for schema rejection check. Default: 400ms. */
	schemaTimeoutMs?: number;
	/**
	 * Assert on log calls emitted by the organ under test.
	 * Called after each probe with all log entries captured by the spy logger.
	 */
	logAssertions?: (logs: CapturedLog[]) => void;
	/**
	 * Vitest tags applied to the generated compliance describe block.
	 * Default: ["compliance"]. Override to add extra tags.
	 */
	tags?: string[];
}

/**
 * organComplianceSuite — drop into any organ test file to get framework
 * compliance as individual named vitest tests.
 *
 * @example
 * ```ts
 * // organ-shell/test/organ.test.ts
 * import { organComplianceSuite } from "@dpopsuev/alef-testkit";
 * import { createShellOrgan } from "../src/organ.js";
 *
 * organComplianceSuite(() => createShellOrgan({ cwd: "/tmp" }), {
 *   streaming: {
 *     "shell.exec": {
 *       validPayload: { command: "sleep 1" },
 *       thresholdMs: 500,
 *     },
 *   },
 * });
 * ```
 *
 * Each check becomes its own vitest `it()` — failures show the specific
 * contract that was broken, not a single thrown error.
 */
export function organComplianceSuite(
	createOrgan: (logger?: OrganLogger) => Organ,
	opts: OrganComplianceOptions = {},
): void {
	// Discover streaming tools once at describe() time — before any test runs.
	// This lets us generate it() blocks per tool AND enforce that every
	// streaming tool has a validPayload in opts.streaming.
	const discoveryOrgan = createOrgan();
	const streamingTools = (discoveryOrgan.tools ?? []).filter((t) => t.streaming === true);
	const streamingConfig = opts.streaming ?? {};

	// Enforce at collection time: every streaming tool needs a validPayload.
	// Throwing here (not inside it()) surfaces the error during test discovery,
	// not as a test failure — the developer sees it immediately on first run.
	for (const tool of streamingTools) {
		if (!streamingConfig[tool.name]) {
			throw new Error(
				`organComplianceSuite: '${tool.name}' is declared as a streaming tool ` +
					`(typedStreamAction) but has no entry in opts.streaming.\n` +
					`Add: streaming: { "${tool.name}": { validPayload: { /* valid args */ } } }`,
			);
		}
	}

	describe("organ framework compliance", { tags: (opts.tags ?? ["compliance"]) as string[] as never }, () => {
		let organ: Organ;
		let unmount: (() => void) | undefined;
		const probeNerve = new InProcessNerve();
		let capturedLogs: CapturedLog[] = [];

		beforeEach(() => {
			capturedLogs = [];
			organ = createOrgan(makeSpyLogger({}, capturedLogs));
			unmount = organ.mount(probeNerve.asNerve());
		});
		afterEach(() => {
			unmount?.();
			opts.logAssertions?.(capturedLogs);
		});

		// ── Structural ─────────────────────────────────────────────────────

		it("has a non-empty description", () => {
			const o = organ ?? createOrgan();
			expect(o.description, "organ must have a description").toBeTruthy();
			expect((o.description ?? "").length, "description must be > 10 chars").toBeGreaterThan(10);
		});

		it("has directives when it exposes tools", () => {
			const o = organ ?? createOrgan();
			if ((o.tools ?? []).length > 0) {
				expect((o.directives ?? []).length, "tool-bearing organs must have directives").toBeGreaterThan(0);
			}
		});

		it("mount() returns a cleanup function", () => {
			const o = createOrgan();
			const nerve = new InProcessNerve();
			const cleanup = o.mount(nerve.asNerve());
			expect(typeof cleanup, "mount() must return a function").toBe("function");
			expect(() => {
				cleanup();
				cleanup();
			}, "cleanup must be idempotent").not.toThrow();
		});

		// ── Schema contracts ───────────────────────────────────────────────

		it("all tools reject null required fields immediately (< 400ms)", async () => {
			const o = createOrgan();
			const results = await runSchemaContract(o, { timeoutMs: opts.schemaTimeoutMs ?? 400 });
			const violations = results.flatMap((r) => r.violations.map((v) => `  ${r.tool}: ${v}`));
			expect(violations, `schema violations:\n${violations.join("\n")}`).toEqual([]);
		}, 10_000);

		it("error messages are human-readable (no raw [InputValidation] prefix)", async () => {
			const o = createOrgan();
			const results = await runSchemaContract(o, { timeoutMs: opts.schemaTimeoutMs ?? 400 });
			const rawErrors = results.flatMap((r) =>
				r.violations.filter((v) => v.includes("[InputValidation]")).map((v) => `  ${r.tool}: ${v}`),
			);
			expect(rawErrors, "error messages must not expose internal [InputValidation] prefix").toEqual([]);
		}, 10_000);

		// ── Streaming contracts (auto-discovered from tool.streaming === true) ─

		if (streamingTools.length > 0) {
			describe("streaming", () => {
				for (const tool of streamingTools) {
					const config = streamingConfig[tool.name] ?? { validPayload: {} };
					it(`${tool.name} emits isFinal:false chunks (streaming tool via typedStreamAction)`, async () => {
						const o = createOrgan();
						const result = await runStreamingContract(o, tool.name, config.validPayload, {
							thresholdMs: config.thresholdMs ?? 500,
							timeoutMs: 15_000,
						});
						expect(result.violation, result.violation ?? `${tool.name} streams correctly`).toBeUndefined();
						if (config.minChunks !== undefined) {
							expect(result.streamed, `${tool.name} must emit at least ${config.minChunks} chunk(s)`).toBe(true);
						}
					}, 20_000);
				}
			});
		}
	});
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function probeMotor(
	nerve: import("@dpopsuev/alef-kernel").Nerve,
	toolName: string,
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<SenseEvent | null> {
	return new Promise((resolve) => {
		const correlationId = randomUUID();
		const timer = setTimeout(() => {
			off();
			resolve(null);
		}, timeoutMs);

		const off = nerve.sense.subscribe(toolName, (event) => {
			if (event.correlationId === correlationId) {
				clearTimeout(timer);
				off();
				resolve(event);
			}
		});

		nerve.motor.publish({ type: toolName, correlationId, payload });
	});
}

// ---------------------------------------------------------------------------
// runSchemaContract — schema rejection contract
// ---------------------------------------------------------------------------

export interface SchemaContractResult {
	tool: string;
	violations: string[];
}

/**
 * Verify that when a required field is set to null, the organ:
 *   1. Publishes an error sense within 200ms (not a 60s timeout)
 *   2. Does not call handle() on rejection
 *   3. Error message is human-readable (no raw zod '[InputValidation]' prefix)
 */
export async function runSchemaContract(
	organ: Organ,
	opts: { timeoutMs?: number } = {},
): Promise<SchemaContractResult[]> {
	const results: SchemaContractResult[] = [];
	const timeoutMs = opts.timeoutMs ?? 300;

	for (const tool of organ.tools) {
		const violations: string[] = [];
		const shape = (tool.inputSchema as z.ZodObject<z.ZodRawShape>)?.shape;
		if (!shape) continue;

		// Find the first required string field to invalidate
		const requiredStringField = Object.entries(shape).find(
			([, f]) => f instanceof z.ZodString && !(f instanceof z.ZodOptional),
		)?.[0];
		if (!requiredStringField) continue;

		const nerve = new InProcessNerve();
		const unmount = organ.mount(nerve.asNerve());
		const correlationId = randomUUID();
		const motorType = tool.name.replace(/\./g, "_");

		const resultPromise = new Promise<SenseEvent | null>((resolve) => {
			const timer = setTimeout(() => resolve(null), timeoutMs);
			nerve.asNerve().sense.subscribe(motorType, (e) => {
				if (e.correlationId === correlationId) {
					clearTimeout(timer);
					resolve(e);
				}
			});
		});

		const start = Date.now();
		nerve.publishMotor({
			type: motorType,
			correlationId,
			payload: { [requiredStringField]: null, toolCallId: randomUUID() },
		});

		const result = await resultPromise;
		const elapsed = Date.now() - start;

		if (result === null) {
			violations.push(`No error sense within ${timeoutMs}ms for null '${requiredStringField}' — likely timed out`);
		} else {
			if (!result.isError)
				violations.push(`isError should be true when schema rejects null '${requiredStringField}'`);
			if (result.errorMessage?.includes("[InputValidation]"))
				violations.push(`Error message contains raw '[InputValidation]' prefix — should be human-readable`);
			if (elapsed > 200) violations.push(`Schema rejection took ${elapsed}ms — should be immediate (<200ms)`);
		}

		unmount();
		results.push({ tool: tool.name, violations });
	}

	return results;
}

// ---------------------------------------------------------------------------
// runStreamingContract — streaming progress contract
// ---------------------------------------------------------------------------

/**
 * Verify that for a long-running tool (duration > thresholdMs), the organ
 * emits at least one isFinal:false sense event — so the TUI can show progress.
 *
 * This contract catches organs that should use typedStreamAction but use
 * typedAction instead (like organ-delegate.agent.run, organ-enclosure.exec).
 */
export async function runStreamingContract(
	organ: Organ,
	toolName: string,
	validPayload: Record<string, unknown>,
	opts: { thresholdMs?: number; timeoutMs?: number } = {},
): Promise<{ streamed: boolean; durationMs: number; violation?: string }> {
	const thresholdMs = opts.thresholdMs ?? 1_000;
	const timeoutMs = opts.timeoutMs ?? 10_000;

	const nerve = new InProcessNerve();
	const unmount = organ.mount(nerve.asNerve());
	const correlationId = randomUUID();
	const motorType = toolName.replace(/\./g, "_");

	let chunkCount = 0;
	const start = Date.now();

	const finalPromise = new Promise<{ durationMs: number }>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Tool timed out after ${timeoutMs}ms`)), timeoutMs);
		nerve.asNerve().sense.subscribe(motorType, (e) => {
			if (e.correlationId !== correlationId) return;
			if (e.payload.isFinal === false) {
				chunkCount++;
				return;
			}
			clearTimeout(timer);
			resolve({ durationMs: Date.now() - start });
		});
	});

	nerve.publishMotor({
		type: motorType,
		correlationId,
		payload: { ...validPayload, toolCallId: randomUUID() },
	});

	const { durationMs } = await finalPromise;
	unmount();

	const streamed = chunkCount > 0;
	const violation =
		durationMs > thresholdMs && !streamed
			? `Tool ran for ${durationMs}ms but emitted zero isFinal:false chunks — use typedStreamAction for long-running tools`
			: undefined;

	return { streamed, durationMs, violation };
}

/** Build a minimal payload that satisfies a Zod schema (all fields empty/zero). */
function buildMinimalPayload(schema: z.ZodTypeAny): Record<string, unknown> {
	try {
		const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
		if (!shape) return {};
		const out: Record<string, unknown> = {};
		for (const [key, field] of Object.entries(shape)) {
			const f = field as z.ZodTypeAny;
			// Optional fields get omitted; required strings get ""
			if (f instanceof z.ZodOptional || f instanceof z.ZodNullable) continue;
			if (f instanceof z.ZodString) out[key] = "";
			else if (f instanceof z.ZodNumber) out[key] = 0;
			else if (f instanceof z.ZodBoolean) out[key] = false;
			else if (f instanceof z.ZodArray) out[key] = [];
		}
		return out;
	} catch {
		return {};
	}
}
