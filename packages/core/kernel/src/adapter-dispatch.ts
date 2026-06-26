import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ZodTypeAny } from "zod";
import type { AccessPolicy } from "./access-policy.js";
import type { CacheStrategy } from "./adapter-cache.js";
import { makeCacheKey } from "./adapter-cache.js";
import type { AdapterLogger, CommandAction, CommandHandlerCtx, EventAction, EventHandlerCtx } from "./adapter-types.js";
import type { Bus, CommandMessage, EventMessage } from "./buses.js";
import { traceEvent } from "./debug.js";
import { buildErrorResult, buildEventResult, extractToolCallId, toErrorMessage } from "./event-builders.js";

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
 * Options for command action dispatch.
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

function validateCommandPayload(
	command: CommandMessage,
	schema: ZodTypeAny | undefined,
	bus: Bus,
): Record<string, unknown> | null {
	if (!schema) return command.payload;
	const result = schema.safeParse(command.payload);
	if (!result.success) {
		const issues = result.error.issues;
		const firstField = String(issues[0]?.path[0] ?? "(root)");
		const humanMsg = issues.map((i) => `'${i.path.join(".") || "(root)"}' ${i.message.toLowerCase()}`).join("; ");
		traceEvent("tool:schema-rejected", {
			name: command.type,
			field: firstField,
			issues: issues.map((i) => ({ path: i.path, message: i.message })),
		});
		const errSense = buildErrorResult(
			command,
			`${command.type}: argument validation failed — ${humanMsg}. Retry with corrected arguments.`,
		);
		bus.event.publish({
			...errSense,
			payload: { ...errSense.payload, _validationError: { field: firstField, message: humanMsg } },
		});
		return null;
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Zod safeParse returns any; all command payloads are Record<string, unknown>
	return result.data as Record<string, unknown>;
}

function buildHandlerCtx(
	command: CommandMessage,
	payload: Record<string, unknown>,
	log: AdapterLogger,
): CommandHandlerCtx {
	const toolCallId = extractToolCallId(command.payload);
	return {
		correlationId: command.correlationId,
		toolCallId,
		payload,
		log: log.child({ correlationId: command.correlationId, ...(toolCallId ? { toolCallId } : {}) }),
	};
}

export async function dispatchCommandAction(
	command: CommandMessage,
	action: CommandAction,
	bus: Bus,
	cache: CacheStrategy,
	log: AdapterLogger,
	schema: ZodTypeAny | undefined,
	options?: DispatchOptions,
): Promise<void> {
	bus.pulse();
	// Yield so waitForToolResult subscribes before the synchronous validation-error path publishes.
	await Promise.resolve();
	const payload = validateCommandPayload(command, schema, bus);
	if (payload === null) return;

	if (options?.policy) {
		const decision = options.policy.check(command.type, payload);
		if (decision.action === "deny") {
			bus.event.publish(buildErrorResult(command, decision.reason ?? `${command.type}: denied by access policy`));
			return;
		}
		if (decision.action === "escalate") {
			const approved = options.onEscalate
				? await options.onEscalate(command.type, payload, decision.reason ?? "")
				: false;
			if (!approved) {
				bus.event.publish(
					buildErrorResult(command, decision.reason ?? `${command.type}: denied (escalation rejected)`),
				);
				return;
			}
		}
	}

	const ctx = buildHandlerCtx(command, payload, log);

	const span = tracer.startSpan(`alef.command/${command.type}`, {
		kind: SpanKind.CONSUMER,
		attributes: {
			"alef.event.type": command.type,
			"alef.correlation.id": command.correlationId,
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

		const cacheKey = makeCacheKey(command.type, command.payload);
		const cached = cache.get(cacheKey);

		if (cached !== undefined) {
			span.setAttribute("alef.cache.hit", true);
			log.debug({ op: command.type, correlationId: command.correlationId, cacheKey }, "cache hit");
			span.addEvent("tool.result", { result: JSON.stringify(cached) });
			bus.event.publish(buildEventResult(command, cached));
			span.setStatus({ code: SpanStatusCode.OK });
			span.end();
			return;
		}
		span.setAttribute("alef.cache.hit", false);

		try {
			let last: Record<string, unknown> | undefined;
			for await (const chunk of action.handle(ctx)) {
				if (last !== undefined) bus.event.publish(buildEventResult(command, { ...last, isFinal: false }));
				last = chunk;
			}
			const result = last ?? {};

			if (action.invalidates) {
				const purged = cache.invalidate(action.invalidates(ctx));
				if (purged.length > 0) {
					span.setAttribute("alef.cache.invalidated", purged.join(","));
					log.debug({ op: command.type, correlationId: command.correlationId, purged }, "cache invalidated");
				}
			}
			if (action.shouldCache?.(ctx, result)) {
				cache.set(cacheKey, result);
				span.setAttribute("alef.cache.stored", true);
				log.debug({ op: command.type, correlationId: command.correlationId, cacheKey }, "result cached");
			}

			// Record tool output so eval harness can check what the tool produced.
			try {
				const resultObj = result;
				const { isFinal: _f, _display: _d, toolCallId: _id, ...resultForLog } = resultObj;
				span.addEvent("tool.result", { result: JSON.stringify(resultForLog) });
			} catch {
				/* non-serialisable result — skip */
			}

			bus.event.publish(buildEventResult(command, { ...result, isFinal: true }));
			span.setStatus({ code: SpanStatusCode.OK });
		} catch (e) {
			log.warn(
				{
					op: command.type,
					correlationId: command.correlationId,
					err: e instanceof Error ? e : new Error(String(e)),
				},
				"command action failed",
			);
			span.recordException(e instanceof Error ? e : new Error(String(e)));
			span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
			bus.event.publish(buildErrorResult(command, toErrorMessage(e)));
		} finally {
			span.end();
		}
	});
}

export function dispatchEventAction(
	eventType: string,
	event: EventMessage,
	bus: Bus,
	senseAction: EventAction,
	log: AdapterLogger,
): void {
	bus.pulse();
	const ctx: EventHandlerCtx = {
		correlationId: event.correlationId,
		payload: event.payload,
		bus: bus,
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
					"event action failed",
				);
				span.recordException(e instanceof Error ? e : new Error(String(e)));
				span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
			})
			.finally(() => span.end()),
	);
}
