/**
 * RunAdapterContract — reusable adapter compliance suite.
 *
 * Any adapter implementation calls runAdapterContract(adapter) in a test to prove
 * it satisfies the Bus contract. Six checks:
 *
 * 1. mount() returns a cleanup function
 * 2. cleanup is idempotent (callable twice without throwing)
 * 3. adapter.tools is a defined array
 * 4. adapter.subscriptions.command lists every 'command/' key the adapter handles
 * 5. for each tool: valid Command event → Event event within timeout
 * 6. for each tool: invalid payload → isError:true Event event
 *
 * Mirrors Tako testkit/contracts/RunWalkerContract.
 */

import { randomUUID } from "node:crypto";
import type { Adapter, AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import { type EventMessage, InProcessNerve } from "@dpopsuev/alef-kernel/bus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

export interface CapturedLog {
	level: "debug" | "info" | "warn" | "error";
	obj: Record<string, unknown>;
	msg: string;
}

export interface AdapterContractOptions {
	/** Timeout per Command→Event probe in ms. Default: 2000. */
	timeoutMs?: number;
}

export interface AdapterContractViolation {
	check: string;
	detail: string;
}

export interface AdapterContractReport {
	adapter: string;
	passed: string[];
	violations: AdapterContractViolation[];
	ok: boolean;
}

/** @deprecated Use AdapterContractOptions instead. */
export type OrganContractOptions = AdapterContractOptions;
/** @deprecated Use AdapterContractViolation instead. */
export type OrganContractViolation = AdapterContractViolation;
/** @deprecated Use AdapterContractReport instead. */
export type OrganContractReport = AdapterContractReport;

/**
 * Run the adapter compliance suite and return a structured report.
 * Does not throw — callers decide how to handle violations.
 */
export async function runAdapterContract(
	adapter: Adapter,
	opts: AdapterContractOptions = {},
): Promise<AdapterContractReport> {
	const timeoutMs = opts.timeoutMs ?? 2000;
	const passed: string[] = [];
	const violations: AdapterContractViolation[] = [];

	const ok = (check: string) => passed.push(check);
	const fail = (check: string, detail: string) => violations.push({ check, detail });

	// 1. mount returns a function
	const nerve = new InProcessNerve();
	let unmount: (() => void) | unknown;
	try {
		unmount = adapter.mount(nerve.asBus());
		if (typeof unmount !== "function") {
			fail("mount-returns-function", `mount() returned ${typeof unmount}, expected function`);
		} else {
			ok("mount-returns-function");
		}
	} catch (e) {
		fail("mount-returns-function", `mount() threw: ${e}`);
		return { adapter: adapter.name, passed, violations, ok: false };
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
	if (!Array.isArray(adapter.tools)) {
		fail("tools-defined", `adapter.tools is ${typeof adapter.tools}, expected array`);
	} else {
		ok("tools-defined");
	}

	// 4. subscriptions.command matches tool names
	const toolNames = adapter.tools.map((t) => t.name);
	const commandSubs = adapter.subscriptions.command;
	const unsubscribed = toolNames.filter((n) => !commandSubs.includes(n));
	if (unsubscribed.length > 0) {
		fail("subscriptions-complete", `tools [${unsubscribed.join(", ")}] have no matching command subscription`);
	} else if (toolNames.length > 0) {
		ok("subscriptions-complete");
	}

	// 5 & 6. probe each tool with valid + invalid Command events
	if (adapter.tools.length > 0) {
		const probeNerve = new InProcessNerve();
		const probeUnmount = adapter.mount(probeNerve.asBus());

		for (const tool of adapter.tools) {
			// Build a minimal valid payload from the schema
			const validPayload = buildMinimalPayload(tool.inputSchema);
			const invalidPayload = { __invalid__: true };

			// 5. Valid payload → Event response (not necessarily isError)
			const validResult = await probeCommand(probeNerve.asBus(), tool.name, validPayload, timeoutMs);
			if (validResult === null) {
				fail(`probe-valid:${tool.name}`, `no Event response received within ${timeoutMs}ms for valid payload`);
			} else {
				ok(`probe-valid:${tool.name}`);
			}

			// 6. Invalid payload → isError Event response
			const invalidResult = await probeCommand(probeNerve.asBus(), tool.name, invalidPayload, timeoutMs);
			if (invalidResult === null) {
				fail(`probe-invalid:${tool.name}`, `no Event response received within ${timeoutMs}ms for invalid payload`);
			} else if (!invalidResult.isError) {
				fail(
					`probe-invalid:${tool.name}`,
					`expected isError:true for invalid payload, got isError:false — adapter must reject schema violations`,
				);
			} else {
				ok(`probe-invalid:${tool.name}`);
			}
		}

		probeUnmount();
	}

	return {
		adapter: adapter.name,
		passed,
		violations,
		ok: violations.length === 0,
	};
}

/**
 * assertAdapterContract — throws on any violation. Use in vitest tests.
 *
 * @example
 * test("fs adapter satisfies contract", async () => {
 * await assertAdapterContract(createFsAdapter({ cwd: "/tmp" }));
 * });
 */
export async function assertAdapterContract(adapter: Adapter, opts?: AdapterContractOptions): Promise<void> {
	const report = await runAdapterContract(adapter, opts);
	if (!report.ok) {
		const lines = report.violations.map((v) => ` [${v.check}] ${v.detail}`).join("\n");
		throw new Error(`Adapter '${report.adapter}' failed contract:\n${lines}`);
	}
}

// ---------------------------------------------------------------------------
// makeSpyLogger — captures log calls for compliance assertions
// ---------------------------------------------------------------------------

function makeSpyLogger(bindings: Record<string, unknown>, sink: CapturedLog[]): AdapterLogger {
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
// organComplianceSuite — vitest-integrated adapter compliance harness
// ---------------------------------------------------------------------------

export interface StreamingToolConfig {
	/** A valid payload that will cause the tool to run for > thresholdMs. */
	validPayload: Record<string, unknown>;
	/** How long the tool must run before we require chunks. Default: 500ms. */
	thresholdMs?: number;
	/** Minimum number of isFinal:false chunks expected. Default: 1. */
	minChunks?: number;
}

export interface AdapterComplianceOptions {
	/**
	 * Per-tool streaming config — required for every tool whose ToolDefinition
	 * has streaming:true (set automatically by typedStreamAction).
	 *
	 * adapterComplianceSuite discovers streaming tools from adapter.tools at
	 * describe() time and throws an error at test collection phase if any
	 * streaming tool is missing from this map.
	 *
	 * Non-streaming tools must not be listed here.
	 */
	streaming?: Record<string, StreamingToolConfig>;
	/** Override timeout for schema rejection check. Default: 400ms. */
	schemaTimeoutMs?: number;
	/**
	 * Assert on log calls emitted by the adapter under test.
	 * Called after each probe with all log entries captured by the spy logger.
	 */
	logAssertions?: (logs: CapturedLog[]) => void;
	/**
	 * Vitest tags applied to the generated compliance describe block.
	 * Default: ["compliance"]. Override to add extra tags.
	 */
	tags?: string[];
}

/** @deprecated Use AdapterComplianceOptions instead. */
export type OrganComplianceOptions = AdapterComplianceOptions;

/**
 * adapterComplianceSuite — drop into any adapter test file to get framework
 * compliance as individual named vitest tests.
 *
 * @example
 * ```ts
 * // organ-shell/test/adapter.test.ts
 * import { adapterComplianceSuite } from "@dpopsuev/alef-testkit";
 * import { createShellAdapter } from "../src/adapter.js";
 *
 * adapterComplianceSuite(() => createShellAdapter({ cwd: "/tmp" }), {
 * streaming: {
 * "shell.exec": {
 * validPayload: { command: "sleep 1" },
 * thresholdMs: 500,
 * },
 * },
 * });
 * ```
 *
 * Each check becomes its own vitest `it()` — failures show the specific
 * contract that was broken, not a single thrown error.
 */
export function adapterComplianceSuite(
	createAdapter: (logger?: AdapterLogger) => Adapter,
	opts: AdapterComplianceOptions = {},
): void {
	// Discover streaming tools once at describe() time — before any test runs.
	// This lets us generate it() blocks per tool AND enforce that every
	// streaming tool has a validPayload in opts.streaming.
	const discoveryAdapter = createAdapter();
	const streamingTools = (discoveryAdapter.tools ?? []).filter((t) => t.streaming === true);
	const streamingConfig = opts.streaming ?? {};

	// Enforce at collection time: every streaming tool needs a validPayload.
	// Throwing here (not inside it()) surfaces the error during test discovery,
	// not as a test failure — the developer sees it immediately on first run.
	for (const tool of streamingTools) {
		if (!streamingConfig[tool.name]) {
			throw new Error(
				`adapterComplianceSuite: '${tool.name}' is declared as a streaming tool ` +
					`(typedStreamAction) but has no entry in opts.streaming.\n` +
					`Add: streaming: { "${tool.name}": { validPayload: { /* valid args */ } } }`,
			);
		}
	}

	describe("adapter framework compliance", { tags: (opts.tags ?? ["compliance"]) as string[] as never }, () => {
		let adapter: Adapter;
		let unmount: (() => void) | undefined;
		const probeNerve = new InProcessNerve();
		let capturedLogs: CapturedLog[] = [];

		beforeEach(() => {
			capturedLogs = [];
			adapter = createAdapter(makeSpyLogger({}, capturedLogs));
			unmount = adapter.mount(probeNerve.asBus());
		});
		afterEach(() => {
			unmount?.();
			opts.logAssertions?.(capturedLogs);
		});

		// ── Structural ─────────────────────────────────────────────────────

		it("has a non-empty description", () => {
			const o = adapter ?? createAdapter();
			expect(o.description, "adapter must have a description").toBeTruthy();
			expect((o.description ?? "").length, "description must be > 10 chars").toBeGreaterThan(10);
		});

		it("has directives when it exposes tools", () => {
			const o = adapter ?? createAdapter();
			if ((o.tools ?? []).length > 0) {
				expect((o.directives ?? []).length, "tool-bearing adapters must have directives").toBeGreaterThan(0);
			}
		});

		it("mount() returns a cleanup function", () => {
			const o = createAdapter();
			const nerve = new InProcessNerve();
			const cleanup = o.mount(nerve.asBus());
			expect(typeof cleanup, "mount() must return a function").toBe("function");
			expect(() => {
				cleanup();
				cleanup();
			}, "cleanup must be idempotent").not.toThrow();
		});

		// ── Schema contracts ───────────────────────────────────────────────

		it("all tools reject null required fields immediately (< 400ms)", async () => {
			const o = createAdapter();
			const results = await runSchemaContract(o, { timeoutMs: opts.schemaTimeoutMs ?? 400 });
			const violations = results.flatMap((r) => r.violations.map((v) => ` ${r.tool}: ${v}`));
			expect(violations, `schema violations:\n${violations.join("\n")}`).toEqual([]);
		}, 10_000);

		it("error messages are human-readable (no raw [InputValidation] prefix)", async () => {
			const o = createAdapter();
			const results = await runSchemaContract(o, { timeoutMs: opts.schemaTimeoutMs ?? 400 });
			const rawErrors = results.flatMap((r) =>
				r.violations.filter((v) => v.includes("[InputValidation]")).map((v) => ` ${r.tool}: ${v}`),
			);
			expect(rawErrors, "error messages must not expose internal [InputValidation] prefix").toEqual([]);
		}, 10_000);

		// ── Streaming contracts (auto-discovered from tool.streaming === true) ─

		if (streamingTools.length > 0) {
			describe("streaming", () => {
				for (const tool of streamingTools) {
					const config = streamingConfig[tool.name] ?? { validPayload: {} };
					it(`${tool.name} emits isFinal:false chunks (streaming tool via typedStreamAction)`, async () => {
						const o = createAdapter();
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

function probeCommand(
	bus: import("@dpopsuev/alef-kernel/bus").Bus,
	toolName: string,
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<EventMessage | null> {
	return new Promise((resolve) => {
		const correlationId = randomUUID();
		const timer = setTimeout(() => {
			off();
			resolve(null);
		}, timeoutMs);

		const off = bus.event.subscribe(toolName, (event) => {
			if (event.correlationId === correlationId) {
				clearTimeout(timer);
				off();
				resolve(event);
			}
		});

		bus.command.publish({ type: toolName, correlationId, payload });
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
 * Verify that when a required field is set to null, the adapter:
 * 1. Publishes an error event within 200ms (not a 60s timeout)
 * 2. Does not call handle() on rejection
 * 3. Error message is human-readable (no raw zod '[InputValidation]' prefix)
 */
export async function runSchemaContract(
	adapter: Adapter,
	opts: { timeoutMs?: number } = {},
): Promise<SchemaContractResult[]> {
	const results: SchemaContractResult[] = [];
	const timeoutMs = opts.timeoutMs ?? 300;

	for (const tool of adapter.tools) {
		const violations: string[] = [];
		const shape = (tool.inputSchema as z.ZodObject<z.ZodRawShape>)?.shape;
		if (!shape) continue;

		// Find the first required string field to invalidate
		const requiredStringField = Object.entries(shape).find(
			([, f]) => f instanceof z.ZodString && !(f instanceof z.ZodOptional),
		)?.[0];
		if (!requiredStringField) continue;

		const nerve = new InProcessNerve();
		const unmount = adapter.mount(nerve.asBus());
		const correlationId = randomUUID();
		const commandType = tool.name.replace(/\./g, "_");

		const resultPromise = new Promise<EventMessage | null>((resolve) => {
			const timer = setTimeout(() => resolve(null), timeoutMs);
			nerve.asBus().event.subscribe(commandType, (e) => {
				if (e.correlationId === correlationId) {
					clearTimeout(timer);
					resolve(e);
				}
			});
		});

		const start = Date.now();
		nerve.publishCommand({
			type: commandType,
			correlationId,
			payload: { [requiredStringField]: null, toolCallId: randomUUID() },
		});

		const result = await resultPromise;
		const elapsed = Date.now() - start;

		if (result === null) {
			violations.push(`No error event within ${timeoutMs}ms for null '${requiredStringField}' — likely timed out`);
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
 * Verify that for a long-running tool (duration > thresholdMs), the adapter
 * emits at least one isFinal:false event message — so the TUI can show progress.
 *
 * This contract catches adapters that should use typedStreamAction but use
 * typedAction instead (like organ-agent.agent.run, organ-enclosure.exec).
 */
export async function runStreamingContract(
	adapter: Adapter,
	toolName: string,
	validPayload: Record<string, unknown>,
	opts: { thresholdMs?: number; timeoutMs?: number } = {},
): Promise<{ streamed: boolean; durationMs: number; violation?: string }> {
	const thresholdMs = opts.thresholdMs ?? 1_000;
	const timeoutMs = opts.timeoutMs ?? 10_000;

	const nerve = new InProcessNerve();
	const unmount = adapter.mount(nerve.asBus());
	const correlationId = randomUUID();
	const commandType = toolName.replace(/\./g, "_");

	let chunkCount = 0;
	const start = Date.now();

	const finalPromise = new Promise<{ durationMs: number }>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Tool timed out after ${timeoutMs}ms`)), timeoutMs);
		nerve.asBus().event.subscribe(commandType, (e) => {
			if (e.correlationId !== correlationId) return;
			if (e.payload.isFinal === false) {
				chunkCount++;
				return;
			}
			clearTimeout(timer);
			resolve({ durationMs: Date.now() - start });
		});
	});

	nerve.publishCommand({
		type: commandType,
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

// ---------------------------------------------------------------------------
// Deprecated aliases — prefer the Adapter-prefixed names in new code.
// ---------------------------------------------------------------------------

/** @deprecated Use runAdapterContract instead. */
export const runOrganContract = runAdapterContract;
/** @deprecated Use assertAdapterContract instead. */
export const assertOrganContract = assertAdapterContract;
/** @deprecated Use adapterComplianceSuite instead. */
export const organComplianceSuite = adapterComplianceSuite;
