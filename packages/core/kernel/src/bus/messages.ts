import { randomUUID } from "node:crypto";
import type { DomainCondition } from "../reconciliation.js";

/** Base envelope for all bus messages, carrying type, correlation, timestamp, and elapsed time. */
export interface BusMessage {
	readonly type: string;
	readonly correlationId: string;
	readonly timestamp: number;
	readonly elapsed: number;
}

/** Bus message representing a tool invocation command with typed payload. */
export interface CommandMessage extends BusMessage {
	readonly type: string;
	readonly payload: Record<string, unknown>;
}

/** Bus message representing a tool result event, optionally carrying an error or domain conditions. */
export interface EventMessage extends BusMessage {
	readonly type: string;
	readonly payload: Record<string, unknown>;
	readonly isError: boolean;
	readonly errorMessage?: string;
	readonly conditions?: readonly DomainCondition[];
}

/** Bus message for fire-and-forget notifications that do not produce results. */
export interface NotificationMessage extends BusMessage {
	readonly type: string;
	readonly payload: Record<string, unknown>;
}

/** Handler callback for command channel messages. */
export type CommandHandler = (event: CommandMessage) => void | Promise<void>;
/** Handler callback for event channel messages. */
export type EventHandler = (event: EventMessage) => void | Promise<void>;
/** Handler callback for notification channel messages. */
export type NotificationHandler = (event: NotificationMessage) => void | Promise<void>;

/** Command message without runtime-generated timestamp and elapsed fields. */
export type CommandInput = Omit<CommandMessage, "timestamp" | "elapsed">;
/** Event message without runtime-generated timestamp and elapsed fields. */
export type EventInput = Omit<EventMessage, "timestamp" | "elapsed">;
/** Notification message without runtime-generated timestamp and elapsed fields. */
export type NotificationInput = Omit<NotificationMessage, "timestamp" | "elapsed">;

/** String constants for the three bus channel names. */
export const CHANNEL = {
	COMMAND: "command",
	EVENT: "event",
	NOTIFICATION: "notification",
} as const;

/** Union of the three bus channel name literals: "command" | "event" | "notification". */
export type ChannelName = (typeof CHANNEL)[keyof typeof CHANNEL];

/** Record keyed by the three channel names, each holding a value of type T. */
export type ChannelMap<T> = { readonly [K in ChannelName]: T };

/** Maps each channel name to its concrete message type. */
export interface ChannelMessages {
	command: CommandMessage;
	event: EventMessage;
	notification: NotificationMessage;
}

/** Type-safe handler for a specific bus channel. */
export type ChannelHandler<K extends ChannelName> = (event: ChannelMessages[K]) => void | Promise<void>;
/** Input type for publishing to a specific channel, without runtime-generated fields. */
export type ChannelInput<K extends ChannelName> = Omit<ChannelMessages[K], "timestamp" | "elapsed">;

/** Publish/subscribe interface for a single bus channel. */
export interface BusChannel<K extends ChannelName = ChannelName> {
	subscribe(type: string, handler: ChannelHandler<K>): () => void;
	publish(event: ChannelInput<K>): void;
}

/** Three-channel bus (command, event, notification) with a watchdog pulse. */
export type Bus = { readonly [K in ChannelName]: BusChannel<K> } & { pulse(): void };

/** Extended bus interface with parameterized publish/subscribe, wildcard listeners, and lifecycle. */
export interface AgentBus {
	publish<K extends ChannelName>(channel: K, event: ChannelInput<K>): void;
	subscribe<K extends ChannelName>(channel: K, type: string, handler: ChannelHandler<K>): () => void;
	onAny(channel: ChannelName, handler: (event: BusMessage) => void): () => void;
	listenerCount(channel: ChannelName, type: string): number;
	asBus(): Bus;
	pulse(): void;
	dispose(): void;
}

/** Scoped bus view that prefixes correlation IDs to isolate traffic. */
export interface BusView extends Bus {
	readonly viewId: string;
}

/** Function that wraps a Bus to add cross-cutting behaviour (limits, logging, etc.). */
export type BusMiddleware = (bus: Bus) => Bus;

/** Assemble a Bus from individual channel implementations and a pulse callback. */
export function makeBus(
	command: BusChannel<"command">,
	event: BusChannel<"event">,
	notification: BusChannel<"notification">,
	pulse: () => void,
): Bus {
	return { command, event, notification, pulse };
}

/** Generate a new UUID-based correlation ID for bus messages. */
export function newCorrelationId(): string {
	return randomUUID();
}
