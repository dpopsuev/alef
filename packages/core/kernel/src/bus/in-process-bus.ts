import { checkChannelViolation } from "./channel-registry.js";
import type {
	Bus,
	BusChannel,
	BusMessage,
	BusView,
	ChannelHandler,
	ChannelInput,
	ChannelName,
	CommandMessage,
} from "./messages.js";
import { makeBus } from "./messages.js";
import { extractToolCallId } from "./event-builders.js";
import { Watchdog } from "./watchdog.js";
import { traceEvent } from "../trace.js";

const FIRST_SEEN_MAX = 500;
/** Low-level pub-sub channel with wildcard support, dead-letter routing, and correlation tracking. */
class InternalBus {
	private readonly handlers = new Map<string, Set<(event: BusMessage) => void | Promise<void>>>();
	readonly firstSeen = new Map<string, number>();
	deadLetterSink?: (event: BusMessage) => void;
	evictCorrelation(correlationId: string): void {
		this.firstSeen.delete(correlationId);
	}
	emit(input: Omit<BusMessage, "timestamp" | "elapsed">): void {
		const now = Date.now();
		if (!this.firstSeen.has(input.correlationId)) {
			this.firstSeen.set(input.correlationId, now);
			if (this.firstSeen.size > FIRST_SEEN_MAX) {
				const oldest = this.firstSeen.keys().next().value;
				if (oldest !== undefined) this.firstSeen.delete(oldest);
			}
		}
		const startedAt = this.firstSeen.get(input.correlationId) ?? now;
		const elapsed = now - startedAt;
		const event: BusMessage = { ...input, timestamp: now, elapsed };
		const specific = this.handlers.get(event.type);
		if (specific && specific.size > 0) {
			for (const h of specific) void h(event);
		} else {
			this.deadLetterSink?.(event);
		}
		const wildcard = this.handlers.get("*");
		if (wildcard) for (const h of wildcard) void h(event);
	}
	on(type: string, handler: (event: BusMessage) => void | Promise<void>): () => void {
		let set = this.handlers.get(type);
		if (!set) {
			set = new Set();
			this.handlers.set(type, set);
		}
		set.add(handler);
		return () => {
			set.delete(handler);
		};
	}
	listenerCount(type: string): number {
		return this.handlers.get(type)?.size ?? 0;
	}
}
/** Configuration for the bus stall-detection watchdog timer. */
export interface WatchdogOptions {
	stallMs: number;
	onStall: () => void;
}
/** Options for constructing an InProcessBus, including watchdog and debug tracing. */
export interface BusOptions {
	watchdog?: WatchdogOptions;
	trace?: boolean;
}
/** Single-process event bus with command/event/notification channels, dead-letter handling, and scoped views. */
export class InProcessBus {
	private readonly _buses: Record<ChannelName, InternalBus> = {
		command: new InternalBus(),
		event: new InternalBus(),
		notification: new InternalBus(),
	};
	private readonly _watchdog: Watchdog | null;
	constructor(optsOrWatchdog?: BusOptions | WatchdogOptions) {
		const opts: BusOptions = optsOrWatchdog && "stallMs" in optsOrWatchdog ? { watchdog: optsOrWatchdog } : (optsOrWatchdog ?? {});
		this._watchdog = opts.watchdog ? new Watchdog(opts.watchdog.stallMs, opts.watchdog.onStall) : null;
		this._watchdog?.start();

		if (opts.trace) {
			const channels = ["command", "event", "notification"] as const;
			for (const ch of channels) {
				this._buses[ch].on("*", (e: BusMessage) => {
					traceEvent(`bus:${ch}:${e.type}`, { correlationId: e.correlationId, elapsed: e.elapsed });
				});
			}
		}
		this._buses.command.deadLetterSink = (event) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dead-letter sink is only wired to command bus
			const payload = (event as CommandMessage).payload;
			const toolCallId = extractToolCallId(payload);
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- emit() adds timestamp/elapsed; object satisfies the remaining fields
			this._buses.event.emit({
				type: event.type,
				correlationId: event.correlationId,
				payload: toolCallId ? { toolCallId } : {},
				isError: true,
				errorMessage: `no adapter handles command/${event.type}`,
			} as unknown as Omit<BusMessage, "timestamp" | "elapsed">);
		};
	}
	/** Reset the watchdog stall timer, indicating activity on the bus. */
	pulse(): void {
		this._watchdog?.reset();
	}
	/** Stop the watchdog and release resources. */
	dispose(): void {
		this._watchdog?.stop();
	}

	// -- Parameterized API (new) ------------------------------------------

	/** Publish a message to the specified channel. */
	publish<K extends ChannelName>(channel: K, event: ChannelInput<K>): void {
		if (channel === "event") this._buses.command.evictCorrelation(event.correlationId);
		this._buses[channel].emit(event);
	}
	/** Subscribe to a specific event type on the given channel, returning an unsubscribe function. */
	subscribe<K extends ChannelName>(channel: K, type: string, handler: ChannelHandler<K>): () => void {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ChannelHandler<K> narrows BusMessage; internal bus stores the generic form
		return this._buses[channel].on(type, handler as (e: BusMessage) => void | Promise<void>);
	}
	/** Subscribe to all event types on the given channel via wildcard. */
	onAny(channel: ChannelName, handler: (event: BusMessage) => void): () => void {
		return this._buses[channel].on("*", handler);
	}
	/** Return the number of listeners registered for the given event type on a channel. */
	listenerCount(channel: ChannelName, type: string): number {
		return this._buses[channel].listenerCount(type);
	}

	/** Create a scoped bus view that isolates traffic by prefixing correlation IDs. */
	createView(viewId: string): BusView {
		const buses = this._buses;
		const pulseFn = () => this.pulse();
		const prefix = `${viewId}:`;

		const scopedSubscribe = (bus: InternalBus) =>
			(type: string, handler: (e: BusMessage) => void | Promise<void>) =>
				bus.on(type, (e: BusMessage) => {
					if (e.correlationId.startsWith(prefix)) void handler(e);
				});

		const scopedPublish = (bus: InternalBus) =>
			(e: Omit<BusMessage, "timestamp" | "elapsed">) =>
				bus.emit({ ...e, correlationId: `${prefix}${e.correlationId}` });

		const commandChannel: BusChannel<"command"> = {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- CommandHandler narrows BusMessage handler
			subscribe: scopedSubscribe(buses.command) as BusChannel<"command">["subscribe"],
			publish: scopedPublish(buses.command),
		};
		const eventChannel: BusChannel<"event"> = {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- EventHandler narrows BusMessage handler
			subscribe: scopedSubscribe(buses.event) as BusChannel<"event">["subscribe"],
			publish: (e) => {
				buses.command.evictCorrelation(`${prefix}${e.correlationId}`);
				scopedPublish(buses.event)(e);
			},
		};
		const notificationChannel: BusChannel<"notification"> = {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- NotificationHandler narrows BusMessage handler
			subscribe: (type, handler) => buses.notification.on(type, handler as (e: BusMessage) => void | Promise<void>),
			publish: (e) => buses.notification.emit(e),
		};

		const bus = makeBus(commandChannel, eventChannel, notificationChannel, pulseFn);
		return { ...bus, viewId };
	}

	// -- Bus view ---------------------------------------------------------

	/** Return an unscoped Bus interface backed by this InProcessBus. */
	asBus(): Bus {
		type InternalHandler = (e: BusMessage) => void | Promise<void>;
		const warnOnViolation = (channel: "command" | "event" | "notification", type: string) => {
			const expected = checkChannelViolation(type, channel);
			if (expected) {
				process.stderr.write(`[bus] channel violation: "${type}" published on ${channel}, expected ${expected}\n`);
			}
		};
		const commandChannel: BusChannel<"command"> = {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- CommandHandler narrows BusMessage handler
			subscribe: (type, handler) => this._buses.command.on(type, handler as InternalHandler),
			publish: (e) => {
				warnOnViolation("command", e.type);
				this._buses.command.emit(e);
			},
		};
		const eventChannel: BusChannel<"event"> = {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- EventHandler narrows BusMessage handler
			subscribe: (type, handler) => this._buses.event.on(type, handler as InternalHandler),
			publish: (e) => {
				warnOnViolation("event", e.type);
				this._buses.command.evictCorrelation(e.correlationId);
				this._buses.event.emit(e);
			},
		};
		const notificationChannel: BusChannel<"notification"> = {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- NotificationHandler narrows BusMessage handler
			subscribe: (type, handler) => this._buses.notification.on(type, handler as InternalHandler),
			publish: (e) => {
				warnOnViolation("notification", e.type);
				this._buses.notification.emit(e);
			},
		};
		return makeBus(commandChannel, eventChannel, notificationChannel, () => this.pulse());
	}
}
