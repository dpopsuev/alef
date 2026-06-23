import type {
	Bus,
	BusMessage,
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
class InProcessBus {
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
export class InProcessNerve {
	private readonly _sense = new InProcessBus();
	private readonly _motor = new InProcessBus();
	/** Signal bus — Reasoner telemetry only. No dead-letter sink; signals have no organ handlers. */
	private readonly _signal = new InProcessBus();
	private readonly _watchdog: Watchdog | null;
	constructor(watchdog?: WatchdogOptions) {
		this._watchdog = watchdog ? new Watchdog(watchdog.stallMs, watchdog.onStall) : null;
		this._watchdog?.start();
		this._motor.deadLetterSink = (event) => {
			const payload = (event as CommandMessage).payload;
			const toolCallId = payload ? extractToolCallId(payload) : undefined;
			this._sense.emit({
				type: event.type,
				correlationId: event.correlationId,
				payload: toolCallId ? { toolCallId } : {},
				isError: true,
				errorMessage: `no adapter handles motor/${event.type}`,
			} as unknown as Omit<BusMessage, "timestamp" | "elapsed">);
		};
		// Signal bus has no dead-letter sink — signals are fire-and-forget to observers.
	}
	pulse(): void {
		this._watchdog?.reset();
	}
	dispose(): void {
		this._watchdog?.stop();
	}
	asBus(): Bus {
		return this._buildBus();
	}
	/** @deprecated Use asBus() */
	asNerve(): Bus {
		return this._buildBus();
	}
	private _buildBus(): Bus {
		const commandChannel = {
			subscribe: (type: string, h: (e: BusMessage) => void | Promise<void>) => this._motor.on(type, h),
			publish: (e: CommandInput) => this._motor.emit(e),
		};
		const eventChannel = {
			subscribe: (type: string, h: (e: BusMessage) => void | Promise<void>) => this._sense.on(type, h),
			publish: (e: EventInput) => {
				this._motor.evictCorrelation(e.correlationId);
				this._sense.emit(e);
			},
		};
		const notificationChannel = {
			subscribe: (type: string, h: (e: BusMessage) => void | Promise<void>) => this._signal.on(type, h),
			publish: (e: NotificationInput) => this._signal.emit(e),
		};
		return makeBus(commandChannel, eventChannel, notificationChannel, () => this.pulse());
	}
	publishMotor(event: CommandInput): void {
		this._motor.emit(event);
	}
	subscribeSense(type: string, handler: EventHandler): () => void {
		return this._sense.on(type, handler as (e: BusMessage) => void | Promise<void>);
	}
	publishSense(event: EventInput): void {
		this._motor.evictCorrelation(event.correlationId);
		this._sense.emit(event);
	}
	publishSignal(event: NotificationInput): void {
		this._signal.emit(event);
	}
	onAnyMotor(handler: (event: BusMessage) => void): () => void {
		return this._motor.on("*", handler);
	}
	onAnySense(handler: (event: BusMessage) => void): () => void {
		return this._sense.on("*", handler);
	}
	onAnySignal(handler: (event: BusMessage) => void): () => void {
		return this._signal.on("*", handler);
	}
	listenerCount(bus: "sense" | "motor" | "signal", type: string): number {
		if (bus === "sense") return this._sense.listenerCount(type);
		if (bus === "signal") return this._signal.listenerCount(type);
		return this._motor.listenerCount(type);
	}
}
