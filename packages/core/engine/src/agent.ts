import { randomUUID } from "node:crypto";
import type { Adapter, AdapterLogger, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import {
	type AgentBus,
	type Binding,
	type Bus,
	type BusMessage,
	type CommandMessage,
	type EventInput,
	type EventMessage,
	InProcessBus,
	makeBus,
	type NotificationInput,
	withAutoTrace,
	withBindings,
} from "@dpopsuev/alef-kernel/bus";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { ZodTypeAny } from "zod";
import { type AdapterPortInfo, PortValidationError, validatePorts } from "./port-registry.js";

// Opt out with ALEF_VALIDATE_PAYLOADS=0. Default on so publish contracts fail closed.
const VALIDATE_PAYLOADS = process.env.ALEF_VALIDATE_PAYLOADS !== "0";

/**
 * Wrap a Bus so publish calls are validated against the adapter's publishSchemas.
 * Returns the original bus when validation is disabled or the adapter declares no schemas.
 */
function withPayloadValidation(bus: Bus, adapter: Adapter): Bus {
	const { command: commandSchemas, event: eventSchemas } = adapter.publishSchemas ?? {};
	if (!VALIDATE_PAYLOADS || (!commandSchemas && !eventSchemas)) return bus;

	const validate = (
		busLabel: "command" | "event",
		schemas: Readonly<Record<string, ZodTypeAny>> | undefined,
		event: BusMessage,
	): string | null => {
		const schema = schemas?.[event.type];
		if (!schema) return null;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage subtype always carries payload; base type omits it
		const result = schema.safeParse((event as { payload?: unknown }).payload);
		if (!result.success) {
			return `[PayloadValidation] ${adapter.name} → ${busLabel}/${event.type}: ${result.error.issues
				.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
				.join("; ")}`;
		}
		return null;
	};

	return makeBus(
		{
			subscribe: bus.command.subscribe.bind(bus.command),
			publish: (event: CommandMessage) => {
				const err = validate("command", commandSchemas, event);
				if (err) {
					// Publish validation failure as an event error so the caller sees a tool result.
					const payload = event.payload as { toolCallId?: string };
					bus.event.publish({
						type: event.type,
						correlationId: event.correlationId,
						isError: true,
						errorMessage: err,
						payload: payload.toolCallId ? { toolCallId: payload.toolCallId } : {},
					});
					return;
				}
				bus.command.publish(event);
			},
		},
		{
			subscribe: bus.event.subscribe.bind(bus.event),
			publish: (event: EventMessage) => {
				// Error events carry { toolCallId } only — validating against the success schema always fails.
				if (!event.isError) {
					const err = validate("event", eventSchemas, event);
					if (err) {
						// Log and drop — event publish failures are non-fatal.
						// Log and drop — event publish failures are non-fatal.
						// Note: withPayloadValidation is used with adapter's bus, but has no logger access
						console.warn(err);
						return;
					}
				}
				bus.event.publish(event);
			},
		},
		bus.notification,
		() => bus.pulse(),
	);
}

/** Tap interface for passively observing all command, event, and notification traffic. */
export interface BusObserver {
	onCommand(event: BusMessage): void;
	onEvent(event: BusMessage): void;
	onNotification?(event: BusMessage): void;
}

/** Reserved for future Agent configuration. */

const noopLogger: AdapterLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => noopLogger,
};

/** Composite adapter host — loads adapters, validates port seams, and manages the shared bus. */
export class Agent {
	private readonly bus: AgentBus;
	private readonly unmounts: Array<() => void> = [];
	private readonly log: AdapterLogger;

	private _toolsCache: ReadonlyArray<ToolDefinition> | null = null;
	get tools(): ReadonlyArray<ToolDefinition> {
		if (this._toolsCache) return this._toolsCache;
		const seen = new Set<string>();
		this._toolsCache = this._adapters
			.flatMap((o) => o.tools)
			.filter((t) => {
				if (seen.has(t.name)) return false;
				seen.add(t.name);
				return true;
			});
		return this._toolsCache;
	}
	private readonly _adapters: Adapter[] = [];
	get adapters(): readonly Adapter[] {
		return this._adapters;
	}
	private readonly _bindings = new Map<string, Binding>();
	private disposed = false;
	/**
	 * AbortController fired on dispose(). Pass signal to long-running adapters
	 * (e.g. adapter-llm) so in-flight HTTP requests are cancelled when the agent
	 * shuts down. Prevents runLLMLoop from continuing after dispose.
	 */
	private readonly controller = new AbortController();
	/** AbortSignal that fires when this agent is disposed. */
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	constructor(options?: { logger?: AdapterLogger; bus?: AgentBus }) {
		this.bus = options?.bus ?? new InProcessBus();
		this.log = options?.logger ?? noopLogger;
	}

	/**
	 * Load an adapter onto the agent.
	 * Always calls mount() exactly once - port detection is deferred to validate().
	 */
	load(adapter: Adapter): this {
		if (this.disposed) throw new Error("Agent is disposed - cannot load adapters.");
		// Push to _adapters tentatively; roll back if mount() throws so indices stay aligned.
		this._adapters.push(adapter);
		this._toolsCache = null;
		let unmount: () => void;
		try {
			const tracedBus = this.asBus();
			const boundBus = this._bindings.size > 0 ? withBindings(this._bindings, tracedBus) : tracedBus;
			unmount = adapter.mount(withPayloadValidation(boundBus, adapter));
		} catch (err) {
			this._adapters.pop();
			this._toolsCache = null;
			throw err;
		}
		this.unmounts.push(unmount);

		// Load-time validation — surface common mistakes early.
		if (adapter.tools.length > 0 && (!adapter.description || adapter.description.trim().length === 0)) {
			this.log.warn(
				{ adapter: adapter.name, toolCount: adapter.tools.length },
				"adapter exposes tools but has no description",
			);
		}
		const existingToolNames = new Set(this._adapters.slice(0, -1).flatMap((o) => o.tools.map((t) => t.name)));
		for (const tool of adapter.tools) {
			if (existingToolNames.has(tool.name)) {
				this.log.warn(
					{ tool: tool.name, adapter: adapter.name },
					"duplicate tool name — adapter shadows previously loaded adapter",
				);
			}
		}

		// Announce all previously loaded adapters to the new adapter (catch-up),
		// then announce the new adapter to everyone. Handlers must be idempotent.
		const sysId = randomUUID();
		for (const loaded of this._adapters) {
			this.bus.publish("event", {
				type: "adapter.loaded",
				correlationId: sysId,
				isError: false,
				payload: {
					name: loaded.name,
					tools: loaded.tools.map((t) => t.name),
					contributions: loaded.contributions,
				},
			});
		}
		return this;
	}

	/**
	 * Validate port cardinality. Call before the first dialog.send().
	 *
	 * Collects PortDefinition contributions from all loaded adapters and validates
	 * cardinality constraints. Adapters self-declare which seam they own via
	 * contributions["port"] — no static registry required.
	 *
	 * Throws PortValidationError on errors (missing/duplicate exactly-one ports).
	 * Logs warnings for zero-or-one violations.
	 */
	validate(): this {
		const infos: AdapterPortInfo[] = this._adapters.map((a) => ({
			name: a.name,
			commandSubscriptions: [...a.subscriptions.command],
			eventSubscriptions: [...a.subscriptions.event],
		}));

		const ports = this._adapters.flatMap((a) => (a.contributions?.port ? [a.contributions.port] : []));

		const result = validatePorts(infos, ports);
		for (const w of result.violations.filter((v) => v.severity === "warning")) {
			this.log.warn({ violation: w.message, severity: w.severity }, "port registry validation warning");
		}
		if (!result.valid) {
			throw new PortValidationError(result.violations.filter((v) => v.severity === "error"));
		}
		return this;
	}

	/**
	 * Inject an event directly onto the agent bus.
	 * Used by autonomous-agent test harnesses to trigger the Reasoner
	 * without going through AgentController.send().
	 */
	publishEvent(event: EventInput): void {
		this.bus.publish("event", event);
	}
	/** Broadcast a signal event to all observers. Used exclusively by the Reasoner (adapter-llm). */
	publishSignal(event: NotificationInput): void {
		this.bus.publish("notification", event);
	}

	private _tracedBus: Bus | undefined;

	asBus(): Bus {
		this._tracedBus ??= withAutoTrace()(this.bus.asBus());
		return this._tracedBus;
	}

	/**
	 * Subscribe to a command event published by the agent.
	 * Returns an unsubscribe function.
	 */
	subscribeCommand(type: string, callback: (event: CommandMessage) => void): () => void {
		return this.bus.asBus().command.subscribe(type, callback);
	}
	/**
	 * Attach a BusObserver for full read access to all bus events.
	 * Used by BusEventRecorder in testkit. Returns unobserve function.
	 */
	observe(observer: BusObserver): () => void {
		const offs = [
			this.bus.onAny("command", (e) => {
				observer.onCommand(e);
			}),
			this.bus.onAny("event", (e) => {
				observer.onEvent(e);
			}),
			this.bus.onAny("notification", (e) => {
				observer.onNotification?.(e);
			}),
		];
		const off = () => {
			for (const o of offs) o();
		};
		this.unmounts.push(off);
		return off;
	}

	/**
	 * Await all adapters that declare ready() before routing events.
	 * Call once after all agent.load() calls, before accepting user input.
	 * If any adapter's ready() rejects, the error includes the adapter name.
	 */
	async ready(): Promise<void> {
		await Promise.all(
			this._adapters
				.filter((o): o is Adapter & { ready: () => Promise<void> } => typeof o.ready === "function")
				.map((o) =>
					o.ready().catch((err: unknown) => {
						throw new Error(`Agent.ready: adapter '${o.name}' failed: ${String(err)}`);
					}),
				),
		);
	}

	/**
	 * Mount the reasoning adapter (adapter-llm or ScriptedReasoner) after all
	 * adapters are loaded. This guarantees the reasoner's getTools()
	 * callback sees the full tool catalog — the implicit ordering requirement
	 * that previously had to be managed by callers is now enforced here.
	 *
	 * Typically called after validate() and ready():
	 *   agent.validate();
	 *   await agent.ready();
	 *   agent.setReasoner(createAgentLoop({ getTools: () => agent.tools, ... }));
	 */
	setReasoner(adapter: Adapter): this {
		return this.load(adapter);
	}

	/**
	 * Unload an adapter by name — unmounts it and removes it from the agent.
	 * Safe to call while the agent is running. Returns true if found.
	 */
	unload(name: string): boolean {
		const idx = this._adapters.findIndex((o) => o.name === name);
		if (idx === -1) return false;
		const adapter = this._adapters[idx]!;
		this.unmounts[idx]!();
		void adapter.close?.();
		this._adapters.splice(idx, 1);
		this.unmounts.splice(idx, 1);
		this._toolsCache = null;

		this.bus.publish("event", {
			type: "adapter.unloaded",
			correlationId: randomUUID(),
			isError: false,
			payload: { name },
		});
		return true;
	}

	/**
	 * Reload an adapter in-place: unload the old instance, load the new one.
	 * Preserves adapter order if the name matches an existing adapter.
	 */
	reload(adapter: Adapter): this {
		this.unload(adapter.name);
		return this.load(adapter);
	}

	bind(binding: Binding): this {
		this._bindings.set(binding.id, binding);
		traceEvent("agent:bind", {
			id: binding.id,
			event: binding.event,
			mode: binding.mode,
			stages: binding.chain.length,
		});
		return this;
	}

	unbind(id: string): boolean {
		const removed = this._bindings.delete(id);
		if (removed) traceEvent("agent:unbind", { id });
		return removed;
	}

	get bindings(): ReadonlyMap<string, Binding> {
		return this._bindings;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.controller.abort();
		for (const unmount of this.unmounts) unmount();
		const closePromises = this._adapters.map((o) => o.close?.()).filter((p): p is Promise<void> => p instanceof Promise);
		await Promise.all(closePromises);
		this.unmounts.length = 0;
	}
}
