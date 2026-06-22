/**
 * Worker thread bootstrap for prototype.plug({ thread: true }).
 *
 * Loaded by Node.js worker_threads with the same execArgv as the parent
 * (inheriting tsx/esm hooks), so TypeScript adapter files load without a build step.
 *
 * Protocol:
 *   parent → worker  { dir: 'motor', event: NerveEvent }
 *   worker → parent  { dir: 'sense', event: SensePublishInput }
 *   worker → parent  { type: 'ready', name, tools[], subscriptions }  (on mount)
 */

import { parentPort, workerData } from "node:worker_threads";
import type {
	MotorEvent,
	MotorHandler,
	Nerve,
	NerveEvent,
	SenseHandler,
	SensePublishInput,
} from "@dpopsuev/alef-kernel";
import { toolInputToJsonSchema } from "@dpopsuev/alef-kernel";

const { organPath: adapterPath, cwd } = workerData as { organPath: string; cwd: string };

const port = parentPort;
if (!port) throw new Error("prototype-worker must run inside a worker_threads.Worker");

// Motor handlers registered by the adapter during mount.
const motorHandlers = new Map<string, Set<MotorHandler>>();
// Sense handlers (rarely used by adapters, but bridge it anyway).
const senseHandlers = new Map<string, Set<SenseHandler>>();

const bridgeNerve: Nerve = {
	pulse() {},
	motor: {
		subscribe(type, handler) {
			let set = motorHandlers.get(type);
			if (!set) {
				set = new Set();
				motorHandlers.set(type, set);
			}
			set.add(handler);
			return () => {
				set?.delete(handler);
			};
		},
		publish(event: MotorEvent) {
			port.postMessage({ dir: "motor", event });
		},
	},
	sense: {
		subscribe(type, handler) {
			let set = senseHandlers.get(type);
			if (!set) {
				set = new Set();
				senseHandlers.set(type, set);
			}
			set.add(handler);
			return () => {
				set?.delete(handler);
			};
		},
		publish(event: SensePublishInput) {
			port.postMessage({ dir: "sense", event });
		},
	},
	signal: {
		subscribe(_type, _handler) {
			return () => {};
		},
		publish(_event) {},
	},
};

// Dispatch incoming motor events to registered handlers.
port.on("message", (msg: { dir: string; event: NerveEvent }) => {
	if (msg.dir !== "motor") return;
	const motorEvent = msg.event as MotorEvent;
	const specific = motorHandlers.get(motorEvent.type);
	if (specific) for (const h of specific) void h(motorEvent);
	const wildcard = motorHandlers.get("*");
	if (wildcard) for (const h of wildcard) void h(motorEvent);
});

// Load the adapter and mount it.
const mod = (await import(adapterPath)) as Record<string, unknown>;
const factory = (mod.createAdapter ?? mod.createOrgan) as (opts: { cwd: string }) => unknown | Promise<unknown>;
const adapter = (await factory({ cwd })) as {
	name: string;
	tools: Array<{ name: string; description: string; inputSchema: import("zod").ZodTypeAny }>;
	subscriptions: { motor: readonly string[]; sense: readonly string[] };
	mount(nerve: Nerve): () => void;
};

adapter.mount(bridgeNerve);

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
