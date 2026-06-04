import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ZodTypeAny } from "zod";
import type { MotorEvent, Nerve } from "./buses.js";
import { invalidateByPrefix, makeCacheKey } from "./organ-cache.js";
import type { CorpusAction, CorpusHandlerCtx, OrganLogger, StreamingCorpusAction } from "./organ-types.js";
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
			const msg = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
			nerve.sense.publish(buildErrSense(motor, `[InputValidation] motor/${motor.type}: ${msg}`));
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
