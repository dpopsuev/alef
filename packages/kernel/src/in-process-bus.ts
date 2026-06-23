import type {
	Bus,
	BusChannel,
	BusMessage,
	ChannelHandler,
	ChannelInput,
	ChannelName,
	CommandInput,
	CommandMessage,
	EventHandler,
	EventInput,
	NotificationInput,
} from "./buses.js";
import { makeBus } from "./buses.js";
import { extractToolCallId } from "./sense-builders.js";
import { Watchdog } from "./watchdog.js";

const FIRST_SEEN_MAX = 500;
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
			set?.delete(handler);
		};
	}
	listenerCount(type: string): number {
		return this.handlers.get(type)?.size ?? 0;
	}
}
export interface WatchdogOptions {
	stallMs: number;
	onStall: () => void;
}
export class InProcessBus {
	private readonly _buses: Record<ChannelName, InternalBus> = {
		command: new InternalBus(),
		event: new InternalBus(),
		notification: new InternalBus(),
	};
	private readonly _watchdog: Watchdog | null;
	constructor(watchdog?: WatchdogOptions) {
		this._watchdog = watchdog ? new Watchdog(watchdog.stallMs, watchdog.onStall) : null;
		this._watchdog?.start();
		this._buses.command.deadLetterSink = (event) => {
			const payload = (event as CommandMessage).payload;
			const toolCallId = payload ? extractToolCallId(payload) : undefined;
			this._buses.event.emit({
				type: event.type,
				correlationId: event.correlationId,
				payload: toolCallId ? { toolCallId } : {},
				isError: true,
				errorMessage: `no adapter handles command/${event.type}`,
			} as unknown as Omit<BusMessage, "timestamp" | "elapsed">);
		};
	}
	pulse(): void {
		this._watchdog?.reset();
	}
	dispose(): void {
		this._watchdog?.stop();
	}

	// -- Parameterized API (new) ------------------------------------------

	publish<K extends ChannelName>(channel: K, event: ChannelInput<K>): void {
		if (channel === "event") this._buses.command.evictCorrelation(event.correlationId);
		this._buses[channel].emit(event);
	}
	subscribe<K extends ChannelName>(channel: K, type: string, handler: ChannelHandler<K>): () => void {
		return this._buses[channel].on(type, handler as (e: BusMessage) => void | Promise<void>);
	}
	onAny(channel: ChannelName, handler: (event: BusMessage) => void): () => void {
		return this._buses[channel].on("*", handler);
	}
	listenerCount(channel: ChannelName, type: string): number {
		return this._buses[channel].listenerCount(type);
	}

	// -- Bus view ---------------------------------------------------------

	asBus(): Bus {
		type InternalHandler = (e: BusMessage) => void | Promise<void>;
		const commandChannel: BusChannel<"command"> = {
			subscribe: (type, handler) => this._buses.command.on(type, handler as InternalHandler),
			publish: (e) => this._buses.command.emit(e),
		};
		const eventChannel: BusChannel<"event"> = {
			subscribe: (type, handler) => this._buses.event.on(type, handler as InternalHandler),
			publish: (e) => {
				this._buses.command.evictCorrelation(e.correlationId);
				this._buses.event.emit(e);
			},
		};
		const notificationChannel: BusChannel<"notification"> = {
			subscribe: (type, handler) => this._buses.notification.on(type, handler as InternalHandler),
			publish: (e) => this._buses.notification.emit(e),
		};
		return makeBus(commandChannel, eventChannel, notificationChannel, () => this.pulse());
	}

	// -- Deprecated channel-specific methods (use parameterized API) ------

	publishCommand(event: CommandInput): void {
		this.publish("command", event);
	}
	subscribeEvent(type: string, handler: EventHandler): () => void {
		return this.subscribe("event", type, handler);
	}
	publishEvent(event: EventInput): void {
		this.publish("event", event);
	}
	publishSignal(event: NotificationInput): void {
		this.publish("notification", event);
	}
	onAnyCommand(handler: (event: BusMessage) => void): () => void {
		return this.onAny("command", handler);
	}
	onAnyEvent(handler: (event: BusMessage) => void): () => void {
		return this.onAny("event", handler);
	}
	onAnyNotification(handler: (event: BusMessage) => void): () => void {
		return this.onAny("notification", handler);
	}
}
