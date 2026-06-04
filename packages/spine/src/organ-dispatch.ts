import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ZodTypeAny } from "zod";
import type { MotorEvent, Nerve, SenseEvent } from "./buses.js";
import { debugLog } from "./debug.js";
import { invalidateByPrefix, makeCacheKey } from "./organ-cache.js";
import type {
	CerebrumAction,
	CerebrumHandlerCtx,
	CorpusAction,
	CorpusHandlerCtx,
	OrganLogger,
	StreamingCorpusAction,
} from "./organ-types.js";
import { buildErrSense, buildSense, extractToolCallId } from "./sense-builders.js";

const tracer = trace.getTracer("alef.spine", "0.0.1");

function isStreaming(action: CorpusAction | StreamingCorpusAction): action is StreamingCorpusAction {
	return "stream" in action;
}

export async function dispatchMotorAction(
	motor: MotorEvent,
	action: CorpusAction | StreamingCorpusAction,
	nerve: Nerve,
	cache: Map<string, Record<string, unknown>>,
	log: OrganLogger,
	schema?: ZodTypeAny,
): Promise<void> {
	// Yield before any sense.publish so waitForToolResult always subscribes first.
	// Without this, the validation-error path publishes synchronously inside motor.publish,
	// before organ-llm calls waitForToolResult — the sense event is lost and the turn hangs.
	// ALE-BUG-50 manifestation: race between dispatchMotorAction and waitForToolResult.
	await Promise.resolve();

	let payload: Record<string, unknown> = motor.payload;
	if (schema) {
		const result = schema.safeParse(motor.payload);
		if (!result.success) {
			const issues = result.error.issues;
			const firstField = String(issues[0]?.path[0] ?? "(root)");
			const humanMsg = issues.map((i) => `'${i.path.join(".") || "(root)"}' ${i.message.toLowerCase()}`).join("; ");
			const errorMsg = `${motor.type}: argument validation failed — ${humanMsg}. Retry with corrected arguments.`;
			debugLog("tool:schema-rejected", {
				name: motor.type,
				field: firstField,
				issues: issues.map((i) => ({ path: i.path, message: i.message })),
			});
			const errSense = buildErrSense(motor, errorMsg);
			// Attach structured validation info so dispatchTools can emit tool-validation-error
			nerve.sense.publish({
				...errSense,
				payload: { ...errSense.payload, _validationError: { field: firstField, message: humanMsg } },
			});
			return;
		}
		payload = result.data as Record<string, unknown>;
	}
	const ctx: CorpusHandlerCtx = {
		correlationId: motor.correlationId,
		toolCallId: extractToolCallId(motor.payload),
		payload,
	};

	if (isStreaming(action)) {
		const span = tracer.startSpan(`alef.motor/${motor.type}`, {
			kind: SpanKind.CONSUMER,
			attributes: {
				"alef.event.type": motor.type,
				"alef.correlation.id": motor.correlationId,
				"alef.tool.call.id": ctx.toolCallId ?? "",
				"alef.stream": true,
			},
		});
		try {
			let last: Record<string, unknown> | undefined;
			for await (const chunk of action.stream(ctx)) {
				if (last !== undefined) nerve.sense.publish(buildSense(motor, { ...last, isFinal: false }));
				last = chunk;
			}
			if (last !== undefined) {
				nerve.sense.publish(buildSense(motor, { ...last, isFinal: true }));
			} else {
				nerve.sense.publish(buildSense(motor, { isFinal: true }));
			}
			span.setStatus({ code: SpanStatusCode.OK });
		} catch (e) {
			log.warn({ op: motor.type, correlationId: motor.correlationId, error: String(e) }, "stream action failed");
			span.recordException(e instanceof Error ? e : new Error(String(e)));
			span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
			nerve.sense.publish(buildErrSense(motor, e instanceof Error ? e.message : String(e)));
		} finally {
			span.end();
		}
		return;
	}

	const span = tracer.startSpan(`alef.motor/${motor.type}`, {
		kind: SpanKind.CONSUMER,
		attributes: {
			"alef.event.type": motor.type,
			"alef.correlation.id": motor.correlationId,
			"alef.tool.call.id": ctx.toolCallId ?? "",
		},
	});

	await context.with(trace.setSpan(context.active(), span), async () => {
		const cacheKey = makeCacheKey(motor.type, motor.payload);
		const cached = cache.get(cacheKey);
		if (cached !== undefined) {
			span.setAttribute("alef.cache.hit", true);
			log.debug({ op: motor.type, correlationId: motor.correlationId, cacheKey }, "cache hit");
			nerve.sense.publish(buildSense(motor, cached));
			span.setStatus({ code: SpanStatusCode.OK });
			span.end();
			return;
		}

		span.setAttribute("alef.cache.hit", false);

		try {
			const result = await action.handle(ctx);

			if (action.invalidates) {
				const types = action.invalidates(ctx);
				const purged = invalidateByPrefix(cache, types);
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

			nerve.sense.publish(buildSense(motor, result));
			span.setStatus({ code: SpanStatusCode.OK });
		} catch (e) {
			log.warn({ op: motor.type, correlationId: motor.correlationId, error: String(e) }, "corpus action failed");
			span.recordException(e instanceof Error ? e : new Error(String(e)));
			span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
			nerve.sense.publish(buildErrSense(motor, e instanceof Error ? e.message : String(e)));
		} finally {
			span.end();
		}
	});
}

export function dispatchSenseAction(
	eventType: string,
	event: SenseEvent,
	nerve: Nerve,
	cerebrumAction: CerebrumAction,
	log: OrganLogger,
): void {
	const ctx: CerebrumHandlerCtx = {
		correlationId: event.correlationId,
		payload: event.payload,
		motor: nerve.motor,
		sense: nerve.sense,
	};
	const span = tracer.startSpan(`alef.sense/${eventType}`, {
		kind: SpanKind.CONSUMER,
		attributes: { "alef.event.type": eventType, "alef.correlation.id": event.correlationId },
	});
	void context.with(trace.setSpan(context.active(), span), () =>
		cerebrumAction
			.handle(ctx)
			.then(() => span.setStatus({ code: SpanStatusCode.OK }))
			.catch((e: unknown) => {
				log.warn({ op: eventType, correlationId: event.correlationId, error: String(e) }, "cerebrum action failed");
				span.recordException(e instanceof Error ? e : new Error(String(e)));
				span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
			})
			.finally(() => span.end()),
	);
}
