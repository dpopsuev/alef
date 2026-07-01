import type { ZodTypeAny } from "zod";
import { z } from "zod";
import type { AdapterContributions } from "./contributions.js";
import type { Bus, ChannelMap } from "../bus/messages.js";

/** Schema and metadata describing a single tool exposed by an adapter. */
export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: ZodTypeAny;
	readonly streaming?: true;
	readonly longRunning?: true;
}

const passthroughRawMap = new WeakMap<ZodTypeAny, Record<string, unknown>>();

/** Wrap a raw JSON Schema object as a Zod type for adapters that bypass Zod parsing. */
export function passthroughSchema(raw: Record<string, unknown>): ZodTypeAny {
	const schema = z.unknown();
	passthroughRawMap.set(schema, raw);
	return schema;
}

/** LLM providers require JSON Schema, not Zod — this bridges the gap. */
export function toolInputToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
	const raw = passthroughRawMap.get(schema);
	if (raw !== undefined) return raw;

	const js = z.toJSONSchema(schema) as Record<string, unknown>;
	const { $schema: _, ...rest } = js as Record<string, unknown> & { $schema?: string };
	return rest;
}

/** A mountable unit that exposes tools, subscribes to bus channels, and contributes extension points. */
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

/** Specialized adapter that drives the LLM loop via a trigger/reply event pair. */
export interface Reasoner extends Adapter {
	readonly tools: readonly [];
	readonly triggerEvent: string;
	readonly replyEvent: string;
}

/** Return true if the adapter exposes no tools and no subscriptions. */
export function isGimped(adapter: Adapter): boolean {
	return (
		adapter.tools.length === 0 &&
		adapter.subscriptions.command.length === 0 &&
		adapter.subscriptions.event.length === 0 &&
		adapter.subscriptions.notification.length === 0
	);
}

/** Create a no-op adapter stub that does nothing when mounted. */
export function gimpedAdapter(name: string): Adapter {
	return {
		name,
		tools: [],
		subscriptions: { command: [], event: [], notification: [] },
		sources: [],
		mount: () => () => {},
	};
}
