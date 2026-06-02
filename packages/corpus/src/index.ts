import {
	type Binding,
	debugLog,
	InProcessNerve,
	type MotorEvent,
	type Nerve,
	type NerveEvent,
	type Organ,
	type OrganPortInfo,
	type PortDefinition,
	PortValidationError,
	type SenseEvent,
	type SensePublishInput,
	STANDARD_PORTS,
	type ToolDefinition,
	validatePorts,
	withBindings,
} from "@dpopsuev/alef-spine";
import type { ZodTypeAny } from "zod";

// ---------------------------------------------------------------------------
// Payload validation — enforces organ-to-organ bus contracts in non-production.
// Active when ALEF_VALIDATE_PAYLOADS=1 or NODE_ENV=test.
// Throws immediately at publish time: organ name + event type + Zod error.
// Zero runtime overhead in production.
// ---------------------------------------------------------------------------

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
	) => {
		const schema = schemas?.[event.type];
		if (!schema) return;
		const result = schema.safeParse((event as { payload?: unknown }).payload);
		if (!result.success) {
			throw new Error(
				`[PayloadValidation] ${organ.name} → ${busLabel}/${event.type}: ${result.error.issues
					.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("; ")}`,
			);
		}
	};

	return {
		motor: {
			subscribe: nerve.motor.subscribe.bind(nerve.motor),
			publish: (event: MotorEvent) => {
				validate("motor", motorSchemas, event);
				nerve.motor.publish(event);
			},
		},
		sense: {
			subscribe: nerve.sense.subscribe.bind(nerve.sense),
			publish: (event: SenseEvent) => {
				// Error Sense events carry { toolCallId } not the success payload shape.
				// Validating them against the success schema always fails — skip.
				if (!event.isError) validate("sense", senseSchemas, event);
				nerve.sense.publish(event);
			},
		},
	};
}

// Corpus event type constants

// ---------------------------------------------------------------------------
// BusObserver - full read access to the Nerve for observability tools.
// Used by BusEventRecorder in testkit. Not an organ - not routed.
// ---------------------------------------------------------------------------

export interface BusObserver {
	onMotorEvent(event: NerveEvent): void;
	onSenseEvent(event: NerveEvent): void;
}

// ---------------------------------------------------------------------------
// Corpus - the composition root and external boundary of the agent.
//
// Responsibilities:
//  - Creates the Spine (InProcessNerve) and owns it exclusively.
//  - Loads organs: mounts them onto the correct Nerve view based on kind.
//  - Collects ToolDefinition from all loaded organs.
//  - observe(): attaches a BusObserver (e.g. BusEventRecorder in tests).
//  - dispose(): tears down all subscriptions cleanly.
// ---------------------------------------------------------------------------

/** Reserved for future Agent configuration. */

export class Agent {
	private readonly nerve = new InProcessNerve();
	private readonly unmounts: Array<() => void> = [];
	/** Tool definitions collected from all loaded organs. */
	private readonly _tools: ToolDefinition[] = [];
	get tools(): ReadonlyArray<ToolDefinition> {
		return this._tools;
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
	 * (e.g. Cerebrum) so in-flight HTTP requests are cancelled when the agent
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
		this._tools.push(...organ.tools);
		return this;
	}

	/**
	 * Validate port cardinality. Call before the first dialog.send().
	 *
	 * Reads organ.subscriptions directly — no probe mount, no state corruption.
	 * The Organ interface requires subscriptions, so TypeScript enforces declaration.
	 * mount() is always called exactly once (in load()).
	 *
	 * Throws PortValidationError on errors (missing/duplicate exactly-one ports).
	 * Logs warnings for zero-or-one violations.
	 */
	validate(seams: PortDefinition[] = STANDARD_PORTS): this {
		const infos: OrganPortInfo[] = this._organs.map((organ) => ({
			name: organ.name,
			motorSubscriptions: [...organ.subscriptions.motor],
			senseSubscriptions: [...organ.subscriptions.sense],
		}));

		const result = validatePorts(infos, seams);
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
		// Recompute tools from remaining organs.
		this._tools.length = 0;
		for (const organ of this._organs) this._tools.push(...organ.tools);
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
