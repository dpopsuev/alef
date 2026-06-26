import { randomUUID } from "node:crypto";
import type { DomainCondition } from "../shared/reconciliation.js";

export interface BusMessage {
	readonly type: string;
	readonly correlationId: string;
	readonly timestamp: number;
	readonly elapsed: number;
}

export interface CommandMessage extends BusMessage {
	readonly type: string;
	readonly payload: Record<string, unknown>;
}

export interface EventMessage extends BusMessage {
	readonly type: string;
	readonly payload: Record<string, unknown>;
	readonly isError: boolean;
	readonly errorMessage?: string;
	readonly conditions?: readonly DomainCondition[];
}

export interface NotificationMessage extends BusMessage {
	readonly type: string;
	readonly payload: Record<string, unknown>;
}

export type CommandHandler = (event: CommandMessage) => void | Promise<void>;
export type EventHandler = (event: EventMessage) => void | Promise<void>;
export type NotificationHandler = (event: NotificationMessage) => void | Promise<void>;

export type CommandInput = Omit<CommandMessage, "timestamp" | "elapsed">;
export type EventInput = Omit<EventMessage, "timestamp" | "elapsed">;
export type NotificationInput = Omit<NotificationMessage, "timestamp" | "elapsed">;

export const CHANNEL = {
	COMMAND: "command",
	EVENT: "event",
	NOTIFICATION: "notification",
} as const;

export type ChannelName = (typeof CHANNEL)[keyof typeof CHANNEL];

export type ChannelMap<T> = { readonly [K in ChannelName]: T };

export interface ChannelMessages {
	command: CommandMessage;
	event: EventMessage;
	notification: NotificationMessage;
}

export type ChannelHandler<K extends ChannelName> = (event: ChannelMessages[K]) => void | Promise<void>;
export type ChannelInput<K extends ChannelName> = Omit<ChannelMessages[K], "timestamp" | "elapsed">;

export interface BusChannel<K extends ChannelName = ChannelName> {
	subscribe(type: string, handler: ChannelHandler<K>): () => void;
	publish(event: ChannelInput<K>): void;
}

export type Bus = { readonly [K in ChannelName]: BusChannel<K> } & { pulse(): void };

export interface AgentBus {
	publish<K extends ChannelName>(channel: K, event: ChannelInput<K>): void;
	subscribe<K extends ChannelName>(channel: K, type: string, handler: ChannelHandler<K>): () => void;
	onAny(channel: ChannelName, handler: (event: BusMessage) => void): () => void;
	listenerCount(channel: ChannelName, type: string): number;
	asBus(): Bus;
	pulse(): void;
	dispose(): void;
}

export type BusMiddleware = (bus: Bus) => Bus;

export function makeBus(
	command: BusChannel<"command">,
	event: BusChannel<"event">,
	notification: BusChannel<"notification">,
	pulse: () => void,
): Bus {
	return { command, event, notification, pulse };
}

export function newCorrelationId(): string {
	return randomUUID();
}
