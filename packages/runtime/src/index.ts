export { AgentController, type AgentControllerOptions, type ReplySink, type Transcript } from "./agent-controller.js";
export type { SubagentFactory, SubagentFactoryOptions } from "./in-process.js";
export { InProcessStrategy } from "./in-process.js";
export { RemoteStrategy, type RemoteStrategyOptions } from "./remote-strategy.js";
export {
	buildAdapterDirectives,
	buildBootCatalog,
	buildOrganDirectives,
	createToolShellAdapter,
	createToolShellOrgan,
	type ToolShellOptions,
} from "./tool-catalog.js";
export {
	type RestartPolicy,
	type SupervisorConfig,
	type ToolServiceConfig,
	ToolSupervisor,
} from "./tool-supervisor.js";

import { randomUUID } from "node:crypto";
import {
	type Adapter,
	type AdapterLogger,
	type Binding,
	type BusMessage,
	type CommandMessage,
	debugLog,
	type EventInput,
	type EventMessage,
	InProcessNerve,
	makeBus,
	type Nerve,
	type NotificationInput,
	type ToolDefinition,
	withBindings,
} from "@dpopsuev/alef-kernel";
import type { ZodTypeAny } from "zod";
import { type OrganPortInfo, PortValidationError, validatePorts } from "./port-registry.js";

const VALIDATE_PAYLOADS = process.env.ALEF_VALIDATE_PAYLOADS === "1" || process.env.NODE_ENV === "test";

/**
 * Wrap a Nerve so publish calls are validated against the adapter's publishSchemas.
 * Returns the original nerve when validation is disabled or the adapter declares no schemas.
 */
function withPayloadValidation(nerve: Nerve, adapter: Adapter): Nerve {
	const { motor: motorSchemas, sense: senseSchemas } = adapter.publishSchemas ?? {};
	if (!VALIDATE_PAYLOADS || (!motorSchemas && !senseSchemas)) return nerve;

	const validate = (
		busLabel: "motor" | "sense",
		schemas: Readonly<Record<string, ZodTypeAny>> | undefined,
		event: BusMessage,
	): string | null => {
		const schema = schemas?.[event.type];
		if (!schema) return null;
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
			subscribe: nerve.command.subscribe.bind(nerve.motor),
			publish: (event: CommandMessage) => {
				const err = validate("motor", motorSchemas, event);
				if (err) {
					// Publish validation failure as a sense error so the caller sees a tool result.
					const payload = event.payload as { toolCallId?: string };
					nerve.event.publish({
						type: event.type,
						correlationId: event.correlationId,
						isError: true,
						errorMessage: err,
						payload: payload.toolCallId ? { toolCallId: payload.toolCallId } : {},
					});
					return;
				}
				nerve.command.publish(event);
			},
		},
		{
			subscribe: nerve.event.subscribe.bind(nerve.sense),
			publish: (event: EventMessage) => {
				// Error events carry { toolCallId } only — validating against the success schema always fails.
				if (!event.isError) {
					const err = validate("sense", senseSchemas, event);
					if (err) {
						// Log and drop — sense publish failures are non-fatal.
						// Log and drop — sense publish failures are non-fatal.
						// Note: withPayloadValidation is used with adapter's nerve, but has no logger access
						console.warn(err);
						return;
					}
				}
				nerve.event.publish(event);
			},
		},
		nerve.signal,
		() => nerve.pulse(),
	);
}

export interface BusObserver {
	onMotorEvent(event: BusMessage): void;
	onSenseEvent(event: BusMessage): void;
	onSignalEvent?(event: BusMessage): void;
}

/** Reserved for future Agent configuration. */

const noopLogger: AdapterLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => noopLogger,
};

export class Agent {
	private readonly nerve = new InProcessNerve();
	private readonly unmounts: Array<() => void> = [];
	private readonly log: AdapterLogger;

	get tools(): ReadonlyArray<ToolDefinition> {
		const seen = new Set<string>();
		return this._organs
			.flatMap((o) => o.tools)
			.filter((t) => {
				if (seen.has(t.name)) return false;
				seen.add(t.name);
				return true;
			});
	}
	private readonly _organs: Adapter[] = [];
	get adapters(): readonly Adapter[] {
		return this._organs;
	}
	/** @deprecated Use adapters */
	get organs(): readonly Adapter[] {
		return this._organs;
	}
	private readonly _bindings = new Map<string, Binding>();
	private disposed = false;
	/**
	 * AbortController fired on dispose(). Pass signal to long-running adapters
	 * (e.g. organ-llm) so in-flight HTTP requests are cancelled when the agent
	 * shuts down. Prevents runLLMLoop from continuing after dispose.
	 */
	private readonly controller = new AbortController();
	/** AbortSignal that fires when this agent is disposed. */
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	constructor(options?: { logger?: AdapterLogger }) {
		this.log = options?.logger ?? noopLogger;
	}

	/**
	 * Load an adapter onto the agent.
	 * Always calls mount() exactly once - port detection is deferred to validate().
	 */
	load(adapter: Adapter): this {
		if (this.disposed) throw new Error("Agent is disposed - cannot load adapters.");
		// Push to _organs tentatively; roll back if mount() throws so indices stay aligned.
		this._organs.push(adapter);
		let unmount: () => void;
		try {
			const boundNerve =
				this._bindings.size > 0 ? withBindings(this._bindings, this.nerve.asNerve()) : this.nerve.asNerve();
			unmount = adapter.mount(withPayloadValidation(boundNerve, adapter));
		} catch (err) {
			this._organs.pop();
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
		const existingToolNames = new Set(this._organs.slice(0, -1).flatMap((o) => o.tools.map((t) => t.name)));
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
		for (const loaded of this._organs) {
			this.nerve.publishSense({
				type: "organ.loaded",
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
		const infos: OrganPortInfo[] = this._organs.map((a) => ({
			name: a.name,
			motorSubscriptions: [...a.subscriptions.motor],
			senseSubscriptions: [...a.subscriptions.sense],
		}));

		const ports = this._organs.flatMap((a) => (a.contributions?.port ? [a.contributions.port] : []));

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
	 * Inject a sense event directly into the agent's spine.
	 * Used by autonomous-agent test harnesses to trigger the Reasoner
	 * without going through AgentController.send().
	 */
	publishSense(event: EventInput): void {
		this.nerve.publishSense(event);
	}

	/** Broadcast a signal event to all observers. Used exclusively by the Reasoner (organ-llm). */
	publishSignal(event: NotificationInput): void {
		this.nerve.publishSignal(event);
	}

	/**
	 * Subscribe to a motor event published by the agent.
	 * Returns an unsubscribe function.
	 */
	subscribeMotor(type: string, callback: (event: CommandMessage) => void): () => void {
		return this.nerve.asNerve().command.subscribe(type, callback);
	}

	/**
	 * Attach a BusObserver for full read access to all bus events.
	 * Used by BusEventRecorder in testkit. Returns unobserve function.
	 */
	observe(observer: BusObserver): () => void {
		const offs = [
			this.nerve.onAnyMotor((e) => {
				observer.onMotorEvent(e);
			}),
			this.nerve.onAnySense((e) => {
				observer.onSenseEvent(e);
			}),
			this.nerve.onAnySignal((e) => {
				observer.onSignalEvent?.(e);
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
			this._organs
				.filter((o): o is Adapter & { ready: () => Promise<void> } => typeof o.ready === "function")
				.map((o) =>
					o.ready().catch((err: unknown) => {
						throw new Error(`Agent.ready: adapter '${o.name}' failed: ${String(err)}`);
					}),
				),
		);
	}

	/**
	 * Mount the reasoning adapter (organ-llm or ScriptedReasoner) after all
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
		const idx = this._organs.findIndex((o) => o.name === name);
		if (idx === -1) return false;
		const adapter = this._organs[idx];
		this.unmounts[idx]?.();
		void adapter?.close?.();
		this._organs.splice(idx, 1);
		this.unmounts.splice(idx, 1);

		this.nerve.publishSense({
			type: "organ.unloaded",
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
		debugLog("agent:bind", {
			id: binding.id,
			event: binding.event,
			mode: binding.mode,
			stages: binding.chain.length,
		});
		return this;
	}

	unbind(id: string): boolean {
		const removed = this._bindings.delete(id);
		if (removed) debugLog("agent:unbind", { id });
		return removed;
	}

	get bindings(): ReadonlyMap<string, Binding> {
		return this._bindings;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.controller.abort();
		for (const unmount of this.unmounts) unmount();
		const closePromises = this._organs.map((o) => o.close?.()).filter((p): p is Promise<void> => p !== undefined);
		void Promise.all(closePromises);
		this.unmounts.length = 0;
	}
}
