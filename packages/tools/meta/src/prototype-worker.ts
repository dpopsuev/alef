/**
 * Worker thread bootstrap for prototype.plug({ thread: true }).
 *
 * Loaded by Node.js worker_threads with the same execArgv as the parent
 * (inheriting tsx/esm hooks), so TypeScript adapter files load without a build step.
 *
 * Protocol:
 *   parent → worker  { dir: 'command', event: BusMessage }
 *   worker → parent  { dir: 'event', event: EventInput }
 *   worker → parent  { type: 'ready', name, tools[], subscriptions }  (on mount)
 */

import { parentPort, workerData } from "node:worker_threads";
import { toolInputToJsonSchema } from "@dpopsuev/alef-kernel/adapter";
import {
	type Bus,
	type BusMessage,
	type CommandHandler,
	type CommandMessage,
	type EventHandler,
	type EventInput,
	makeBus,
} from "@dpopsuev/alef-kernel/bus";

const { adapterPath, cwd } = workerData as { adapterPath: string; cwd: string };

const port = parentPort;
if (!port) throw new Error("prototype-worker must run inside a worker_threads.Worker");

// Command handlers registered by the adapter during mount.
const commandHandlers = new Map<string, Set<CommandHandler>>();
// Event handlers (rarely used by adapters, but bridge it anyway).
const eventHandlers = new Map<string, Set<EventHandler>>();

const bridgeBus: Bus = makeBus(
	{
		subscribe(type, handler) {
			let set = commandHandlers.get(type);
			if (!set) {
				set = new Set();
				commandHandlers.set(type, set);
			}
			set.add(handler);
			return () => {
				set?.delete(handler);
			};
		},
		publish(event: CommandMessage) {
			port.postMessage({ dir: "command", event });
		},
	},
	{
		subscribe(type, handler) {
			let set = eventHandlers.get(type);
			if (!set) {
				set = new Set();
				eventHandlers.set(type, set);
			}
			set.add(handler);
			return () => {
				set?.delete(handler);
			};
		},
		publish(event: EventInput) {
			port.postMessage({ dir: "event", event });
		},
	},
	{
		subscribe(_type, _handler) {
			return () => {};
		},
		publish(_event) {},
	},
	() => {},
);

// Dispatch incoming command events to registered handlers.
port.on("message", (msg: { dir: string; event: BusMessage }) => {
	if (msg.dir !== "command") return;
	const commandEvent = msg.event as CommandMessage;
	const specific = commandHandlers.get(commandEvent.type);
	if (specific) for (const h of specific) void h(commandEvent);
	const wildcard = commandHandlers.get("*");
	if (wildcard) for (const h of wildcard) void h(commandEvent);
});

// Load the adapter and mount it.
const mod = (await import(adapterPath)) as Record<string, unknown>;
const factory = mod.createAdapter as (opts: { cwd: string }) => unknown | Promise<unknown>;
const adapter = (await factory({ cwd })) as {
	name: string;
	tools: Array<{ name: string; description: string; inputSchema: import("zod").ZodTypeAny }>;
	subscriptions: { command: readonly string[]; event: readonly string[]; notification: readonly string[] };
	mount(bus: Bus): () => void;
};

adapter.mount(bridgeBus);

port.postMessage({
	type: "ready",
	name: adapter.name,
	tools: adapter.tools.map((t) => ({
		name: t.name,
		description: t.description,
		jsonSchema: toolInputToJsonSchema(t.inputSchema),
	})),
	subscriptions: adapter.subscriptions,
});
