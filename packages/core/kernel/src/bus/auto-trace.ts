import { traceEvent } from "../trace.js";
import type { Bus, BusMiddleware, ChannelName } from "./messages.js";
import { makeBus } from "./messages.js";

/**
 * Bus middleware that automatically traces every publish.
 * Emits a traceEvent for each event crossing the bus — zero manual
 * instrumentation needed. Events are traced as:
 *   bus:{channel}:{type}  { correlationId, payloadKeys }
 *
 * This replaces manual traceEvent("observer:convert"...) calls at
 * individual chain links. The bus IS the chain — tracing the bus
 * traces the chain.
 */
export function withAutoTrace(): BusMiddleware {
	return (bus: Bus): Bus => {
		const trace = (channel: ChannelName, event: { type: string; correlationId: string; payload?: unknown }) => {
			const payloadKeys = event.payload && typeof event.payload === "object"
				? Object.keys(event.payload).join(",")
				: "";
			traceEvent(`bus:${channel}:${event.type}`, {
				correlationId: event.correlationId,
				...(payloadKeys ? { payloadKeys } : {}),
			});
		};

		return makeBus(
			{
				subscribe: bus.command.subscribe.bind(bus.command),
				publish: (e) => {
					trace("command", e);
					bus.command.publish(e);
				},
			},
			{
				subscribe: bus.event.subscribe.bind(bus.event),
				publish: (e) => {
					trace("event", e);
					bus.event.publish(e);
				},
			},
			{
				subscribe: bus.notification.subscribe.bind(bus.notification),
				publish: (e) => {
					trace("notification", e);
					bus.notification.publish(e);
				},
			},
			() => bus.pulse(),
		);
	};
}
