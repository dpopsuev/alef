export type { SubagentFactory, SubagentFactoryOptions } from "./in-process.js";
export { InProcessStrategy } from "./in-process.js";
export { RemoteStrategy, type RemoteStrategyOptions } from "./remote-strategy.js";

import { randomUUID } from "node:crypto";
import {
	type Binding,
	debugLog,
	InProcessNerve,
	type MotorEvent,
	type Nerve,
	type NerveEvent,
	type Organ,
	type SenseEvent,
	type SensePublishInput,
	type SignalPublishInput,
	type ToolDefinition,
	withBindings,
} from "@dpopsuev/alef-kernel";
import type { ZodTypeAny } from "zod";
import { type OrganPortInfo, PortValidationError, validatePorts } from "./port-registry.js";

const VALIDATE_PAYLOADS = process.env.ALEF_VALIDATE_PAYLOADS === "1" || process.env.NODE_ENV === "test";

/**
 * Wrap a Nerve so publish calls are validated against the organ's publishSchemas.
 * Returns the original nerve when validation is disabled or the organ declares no schemas.
 */
function withPayloadValidation(nerve: Nerve, organ: Organ): Nerve {
	const { motor: motorSchemas, sense: senseSchemas } = organ.publishSchemas ?? {};
	if (!VALIDATE_PAYLOADS || (!motorSchemas && !senseSchemas)) return nerve;

	const validate = (
		busLabel: "motor" | "sense",
		schemas: Readonly<Record<string, ZodTypeAny>> | undefined,
		event: NerveEvent,
	): string | null => {
		const schema = schemas?.[event.type];
		if (!schema) return null;
		const result = schema.safeParse((event as { payload?: unknown }).payload);
		if (!result.success) {
			return `[PayloadValidation] ${organ.name} → ${busLabel}/${event.type}: ${result.error.issues
				.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
				.join("; ")}`;
		}
		return null;
	};

	return {
		motor: {
			subscribe: nerve.motor.subscribe.bind(nerve.motor),
			publish: (event: MotorEvent) => {
				const err = validate("motor", motorSchemas, event);
				if (err) {
					// Publish validation failure as a sense error so the caller sees a tool result.
					const payload = event.payload as { toolCallId?: string };
					nerve.sense.publish({
						type: event.type,
						correlationId: event.correlationId,
						isError: true,
						errorMessage: err,
						payload: payload.toolCallId ? { toolCallId: payload.toolCallId } : {},
					});
					return;
				}
				nerve.motor.publish(event);
			},
		},
		sense: {
			subscribe: nerve.sense.subscribe.bind(nerve.sense),
			publish: (event: SenseEvent) => {
				// Error events carry { toolCallId } only — validating against the success schema always fails.
				if (!event.isError) {
					const err = validate("sense", senseSchemas, event);
					if (err) {
						// Log and drop — sense publish failures are non-fatal.
						console.warn(err);
						return;
					}
				}
				nerve.sense.publish(event);
			},
		},
		signal: nerve.signal,
		pulse: () => nerve.pulse(),
	};
}

export interface BusObserver {
	onMotorEvent(event: NerveEvent): void;
	onSenseEvent(event: NerveEvent): void;
	onSignalEvent?(event: NerveEvent): void;
}

/** Reserved for future Agent configuration. */

export class Agent {
	private readonly nerve = new InProcessNerve();
	private readonly unmounts: Array<() => void> = [];
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
	/** Organs stored for lazy port detection in validate(). */
	private readonly _organs: Organ[] = [];
	/** Loaded organs in mount order. Includes metadata (description, labels). */
	get organs(): readonly Organ[] {
		return this._organs;
	}
	private readonly _bindings = new Map<string, Binding>();
	private disposed = false;
	/**
	 * AbortController fired on dispose(). Pass signal to long-running organs
	 * (e.g. organ-llm) so in-flight HTTP requests are cancelled when the agent
	 * shuts down. Prevents runLLMLoop from continuing after dispose.
	 */
	private readonly controller = new AbortController();
	/** AbortSignal that fires when this agent is disposed. */
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/**
	 * Load an organ onto the agent.
	 * Always calls mount() exactly once - port detection is deferred to validate().
	 */
	load(organ: Organ): this {
		if (this.disposed) throw new Error("Agent is disposed - cannot load organs.");
		// Push to _organs tentatively; roll back if mount() throws so indices stay aligned.
		this._organs.push(organ);
		let unmount: () => void;
		try {
			const boundNerve =
				this._bindings.size > 0 ? withBindings(this._bindings, this.nerve.asNerve()) : this.nerve.asNerve();
			unmount = organ.mount(withPayloadValidation(boundNerve, organ));
		} catch (err) {
			this._organs.pop();
			throw err;
		}
		this.unmounts.push(unmount);

		// Load-time validation — surface common mistakes early.
		if (organ.tools.length > 0 && (!organ.description || organ.description.trim().length === 0)) {
			console.warn(`[Agent.load] '${organ.name}' exposes ${organ.tools.length} tool(s) but has no description.`);
		}
		const existingToolNames = new Set(this._organs.slice(0, -1).flatMap((o) => o.tools.map((t) => t.name)));
		for (const tool of organ.tools) {
			if (existingToolNames.has(tool.name)) {
				console.warn(
					`[Agent.load] duplicate tool '${tool.name}' — '${organ.name}' shadows a previously loaded organ.`,
				);
			}
		}

		// Announce all previously loaded organs to the new organ (catch-up),
		// then announce the new organ to everyone. Handlers must be idempotent.
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
	 * Collects PortDefinition contributions from all loaded organs and validates
	 * cardinality constraints. Organs self-declare which seam they own via
	 * contributions["port"] — no static registry required.
	 *
	 * Throws PortValidationError on errors (missing/duplicate exactly-one ports).
	 * Logs warnings for zero-or-one violations.
	 */
	validate(): this {
		const infos: OrganPortInfo[] = this._organs.map((organ) => ({
			name: organ.name,
			motorSubscriptions: [...organ.subscriptions.motor],
			senseSubscriptions: [...organ.subscriptions.sense],
		}));

		const ports = this._organs.flatMap((organ) => (organ.contributions?.port ? [organ.contributions.port] : []));

		const result = validatePorts(infos, ports);
		for (const w of result.violations.filter((v) => v.severity === "warning")) {
			console.warn(`[PortRegistry] ${w.message}`);
		}
		if (!result.valid) {
			throw new PortValidationError(result.violations.filter((v) => v.severity === "error"));
		}
		return this;
	}

	/**
	 * Inject a sense event directly into the agent's spine.
	 * Used by autonomous-agent test harnesses to trigger the Reasoner
	 * without going through DialogOrgan.send().
	 */
	publishSense(event: SensePublishInput): void {
		this.nerve.publishSense(event);
	}

	/** Broadcast a signal event to all observers. Used exclusively by the Reasoner (organ-llm). */
	publishSignal(event: SignalPublishInput): void {
		this.nerve.publishSignal(event);
	}

	/**
	 * Subscribe to a motor event published by the agent.
	 * Returns an unsubscribe function.
	 */
	subscribeMotor(type: string, callback: (event: MotorEvent) => void): () => void {
		return this.nerve.asNerve().motor.subscribe(type, callback);
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
	 * Await all organs that declare ready() before routing events.
	 * Call once after all agent.load() calls, before accepting user input.
	 * If any organ's ready() rejects, the error includes the organ name.
	 */
	async ready(): Promise<void> {
		await Promise.all(
			this._organs
				.filter((o): o is Organ & { ready: () => Promise<void> } => typeof o.ready === "function")
				.map((o) =>
					o.ready().catch((err: unknown) => {
						throw new Error(`Agent.ready: organ '${o.name}' failed: ${String(err)}`);
					}),
				),
		);
	}

	/**
	 * Mount the reasoning organ (organ-llm or ScriptedReasoner) after all
	 * organs are loaded. This guarantees the reasoner's getTools()
	 * callback sees the full tool catalog — the implicit ordering requirement
	 * that previously had to be managed by callers is now enforced here.
	 *
	 * Typically called after validate() and ready():
	 *   agent.validate();
	 *   await agent.ready();
	 *   agent.setReasoner(createAgentLoop({ getTools: () => agent.tools, ... }));
	 */
	setReasoner(organ: Organ): this {
		return this.load(organ);
	}

	/**
	 * Unload an organ by name — unmounts it and removes it from the agent.
	 * Safe to call while the agent is running. Returns true if found.
	 */
	unload(name: string): boolean {
		const idx = this._organs.findIndex((o) => o.name === name);
		if (idx === -1) return false;
		const organ = this._organs[idx];
		this.unmounts[idx]?.();
		void organ?.close?.();
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
	 * Reload an organ in-place: unload the old instance, load the new one.
	 * Preserves organ order if the name matches an existing organ.
	 */
	reload(organ: Organ): this {
		this.unload(organ.name);
		return this.load(organ);
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
