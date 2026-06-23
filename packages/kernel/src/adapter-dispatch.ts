import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ZodTypeAny } from "zod";
import type { AccessPolicy } from "./access-policy.js";
import type { CacheStrategy } from "./adapter-cache.js";
import { makeCacheKey } from "./adapter-cache.js";
import type { AdapterLogger, CommandAction, CommandHandlerCtx, EventAction, EventHandlerCtx } from "./adapter-types.js";
import type { Bus, CommandMessage, EventMessage } from "./buses.js";
import { traceEvent } from "./debug.js";
import { buildErrSense, buildSense, extractToolCallId, toErrorMessage } from "./sense-builders.js";

/**
 * Escalation callback for access policy decisions.
 * Returns true if the tool call should be allowed, false to deny.
 */
export type EscalationHandler = (
	toolName: string,
	payload: Record<string, unknown>,
	reason: string,
) => Promise<boolean>;

/**
 * Options for motor action dispatch.
 */
export interface DispatchOptions {
	/**
	 * Access policy to check before executing the action.
	 * If undefined, all actions are allowed.
	 */
	policy?: AccessPolicy;
	/**
	 * Escalation handler called when policy returns 'escalate'.
	 * If undefined, escalations are denied.
	 */
	onEscalate?: EscalationHandler;
}

const tracer = trace.getTracer("alef.spine", "0.0.1");

function validateMotorPayload(
	motor: CommandMessage,
	schema: ZodTypeAny | undefined,
	nerve: Bus,
): Record<string, unknown> | null {
	if (!schema) return motor.payload;
	const result = schema.safeParse(motor.payload);
	if (!result.success) {
		const issues = result.error.issues;
		const firstField = String(issues[0]?.path[0] ?? "(root)");
		const humanMsg = issues.map((i) => `'${i.path.join(".") || "(root)"}' ${i.message.toLowerCase()}`).join("; ");
		traceEvent("tool:schema-rejected", {
			name: motor.type,
			field: firstField,
			issues: issues.map((i) => ({ path: i.path, message: i.message })),
		});
		const errSense = buildErrSense(
			motor,
			`${motor.type}: argument validation failed — ${humanMsg}. Retry with corrected arguments.`,
		);
		nerve.event.publish({
			...errSense,
			payload: { ...errSense.payload, _validationError: { field: firstField, message: humanMsg } },
		});
		return null;
	}
	return result.data as Record<string, unknown>;
}

function buildHandlerCtx(
	motor: CommandMessage,
	payload: Record<string, unknown>,
	log: AdapterLogger,
): CommandHandlerCtx {
	const toolCallId = extractToolCallId(motor.payload);
	return {
		correlationId: motor.correlationId,
		toolCallId,
		payload,
		log: log.child({ correlationId: motor.correlationId, ...(toolCallId ? { toolCallId } : {}) }),
	};
}

export async function dispatchCommandAction(
	motor: CommandMessage,
	action: CommandAction,
	nerve: Bus,
	cache: CacheStrategy,
	log: AdapterLogger,
	schema: ZodTypeAny | undefined,
	options?: DispatchOptions,
): Promise<void> {
	nerve.pulse();
	// Yield so waitForToolResult subscribes before the synchronous validation-error path publishes.
	await Promise.resolve();
	const payload = validateMotorPayload(motor, schema, nerve);
	if (payload === null) return;

	if (options?.policy) {
		const decision = options.policy.check(motor.type, payload);
		if (decision.action === "deny") {
			nerve.event.publish(buildErrSense(motor, decision.reason ?? `${motor.type}: denied by access policy`));
			return;
		}
		if (decision.action === "escalate") {
			const approved = options.onEscalate
				? await options.onEscalate(motor.type, payload, decision.reason ?? "")
				: false;
			if (!approved) {
				nerve.event.publish(buildErrSense(motor, decision.reason ?? `${motor.type}: denied (escalation rejected)`));
				return;
			}
		}
	}

	const ctx = buildHandlerCtx(motor, payload, log);

	const span = tracer.startSpan(`alef.command/${motor.type}`, {
		kind: SpanKind.CONSUMER,
		attributes: {
			"alef.event.type": motor.type,
			"alef.correlation.id": motor.correlationId,
			"alef.tool.call.id": ctx.toolCallId ?? "",
		},
	});

	await context.with(trace.setSpan(context.active(), span), async () => {
		// Record tool input args so eval harness can check what the tool was called on.
		try {
			span.addEvent("tool.args", { args: JSON.stringify(payload) });
		} catch {
			/* non-serialisable payload — skip */
		}

		const cacheKey = makeCacheKey(motor.type, motor.payload);
		const cached = cache.get(cacheKey);

		if (cached !== undefined) {
			span.setAttribute("alef.cache.hit", true);
			log.debug({ op: motor.type, correlationId: motor.correlationId, cacheKey }, "cache hit");
			span.addEvent("tool.result", { result: JSON.stringify(cached) });
			nerve.event.publish(buildSense(motor, cached));
			span.setStatus({ code: SpanStatusCode.OK });
			span.end();
			return;
		}
		span.setAttribute("alef.cache.hit", false);

		try {
			let last: Record<string, unknown> | undefined;
			for await (const chunk of action.handle(ctx)) {
				if (last !== undefined) nerve.event.publish(buildSense(motor, { ...last, isFinal: false }));
				last = chunk;
			}
			const result = last ?? {};

			if (action.invalidates) {
				const purged = cache.invalidate(action.invalidates(ctx));
				if (purged.length > 0) {
					span.setAttribute("alef.cache.invalidated", purged.join(","));
					log.debug({ op: motor.type, correlationId: motor.correlationId, purged }, "cache invalidated");
				}
			}
			if (action.shouldCache?.(ctx, result)) {
				cache.set(cacheKey, result);
				span.setAttribute("alef.cache.stored", true);
				log.debug({ op: motor.type, correlationId: motor.correlationId, cacheKey }, "result cached");
			}

			// Record tool output so eval harness can check what the tool produced.
			try {
				const resultObj = result;
				const { isFinal: _f, _display: _d, toolCallId: _id, ...resultForLog } = resultObj;
				span.addEvent("tool.result", { result: JSON.stringify(resultForLog) });
			} catch {
				/* non-serialisable result — skip */
			}

			nerve.event.publish(buildSense(motor, { ...result, isFinal: true }));
			span.setStatus({ code: SpanStatusCode.OK });
		} catch (e) {
			log.warn(
				{ op: motor.type, correlationId: motor.correlationId, err: e instanceof Error ? e : new Error(String(e)) },
				"motor action failed",
			);
			span.recordException(e instanceof Error ? e : new Error(String(e)));
			span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
			nerve.event.publish(buildErrSense(motor, toErrorMessage(e)));
		} finally {
			span.end();
		}
	});
}

export function dispatchEventAction(
	eventType: string,
	event: EventMessage,
	nerve: Bus,
	senseAction: EventAction,
	log: AdapterLogger,
): void {
	nerve.pulse();
	const ctx: EventHandlerCtx = {
		correlationId: event.correlationId,
		payload: event.payload,
		command: nerve.command,
		event: nerve.event,
		notification: nerve.notification,
	};
	const span = tracer.startSpan(`alef.event/${eventType}`, {
		kind: SpanKind.CONSUMER,
		attributes: { "alef.event.type": eventType, "alef.correlation.id": event.correlationId },
	});
	void context.with(trace.setSpan(context.active(), span), () =>
		senseAction
			.handle(ctx)
			.then(() => span.setStatus({ code: SpanStatusCode.OK }))
			.catch((e: unknown) => {
				log.warn(
					{
						op: eventType,
						correlationId: event.correlationId,
						err: e instanceof Error ? e : new Error(String(e)),
					},
					"sense action failed",
				);
				span.recordException(e instanceof Error ? e : new Error(String(e)));
				span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
			})
			.finally(() => span.end()),
	);
}
