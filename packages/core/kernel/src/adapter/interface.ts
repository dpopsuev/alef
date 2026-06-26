import type { ZodTypeAny } from "zod";
import { z } from "zod";
import type { AdapterContributions } from "./contributions.js";
import type { Bus, ChannelMap } from "../bus/messages.js";

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: ZodTypeAny;
	readonly streaming?: true;
	readonly longRunning?: true;
}

const passthroughRawMap = new WeakMap<ZodTypeAny, Record<string, unknown>>();

export function passthroughSchema(raw: Record<string, unknown>): ZodTypeAny {
	const schema = z.unknown();
	passthroughRawMap.set(schema, raw);
	return schema;
}

export function toolInputToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
	const raw = passthroughRawMap.get(schema);
	if (raw !== undefined) return raw;

	const js = z.toJSONSchema(schema) as Record<string, unknown>;
	const { $schema: _, ...rest } = js as Record<string, unknown> & { $schema?: string };
	return rest;
}

export interface Adapter {
	readonly name: string;
	readonly tools: readonly ToolDefinition[];
	mount(bus: Bus): () => void;
	close?(): Promise<void>;
	readonly subscriptions: ChannelMap<readonly string[]>;
	readonly sources: readonly {
		readonly name: string;
		readonly kind: "file" | "memory" | "process";
	}[];
	readonly directives?: readonly string[];
	readonly contributions?: AdapterContributions;
	readonly description?: string;
	readonly labels?: readonly string[];
	readonly publishSchemas?: Partial<ChannelMap<Readonly<Record<string, ZodTypeAny>>>>;
	readonly inputSchemas?: Partial<ChannelMap<Readonly<Record<string, ZodTypeAny>>>>;
	ready?(): Promise<void>;
}

export interface Reasoner extends Adapter {
	readonly tools: readonly [];
	readonly triggerEvent: string;
	readonly replyEvent: string;
}

export function isGimped(adapter: Adapter): boolean {
	return (
		adapter.tools.length === 0 &&
		adapter.subscriptions.command.length === 0 &&
		adapter.subscriptions.event.length === 0 &&
		adapter.subscriptions.notification.length === 0
	);
}

export function gimpedAdapter(name: string): Adapter {
	return {
		name,
		tools: [],
		subscriptions: { command: [], event: [], notification: [] },
		sources: [],
		mount: () => () => {},
	};
}
