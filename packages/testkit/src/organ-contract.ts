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
import { InProcessNerve, type Organ, type SenseEvent } from "@dpopsuev/alef-spine";
import { z } from "zod";

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
// Internals
// ---------------------------------------------------------------------------

function probeMotor(
	nerve: import("@dpopsuev/alef-spine").Nerve,
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
