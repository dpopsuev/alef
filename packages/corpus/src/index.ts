import {
	InProcessNerve,
	type MotorEvent,
	type Nerve,
	type NerveEvent,
	type Organ,
	type OrganPortInfo,
	type PortDefinition,
	PortValidationError,
	type SenseEvent,
	STANDARD_PORTS,
	type ToolDefinition,
	validatePorts,
} from "@dpopsuev/alef-spine";

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
		schemas: Readonly<Record<string, import("zod").ZodTypeAny>> | undefined,
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
				validate("sense", senseSchemas, event);
				nerve.sense.publish(event);
			},
		},
	};
}

// Corpus event type constants
export const DIALOG_MESSAGE = "dialog.message" as const;
export { PortValidationError, STANDARD_PORTS, validatePorts } from "@dpopsuev/alef-spine";

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
export interface AgentOptions {}

export class Agent {
	private readonly nerve = new InProcessNerve();
	private readonly unmounts: Array<() => void> = [];
	/** Tool definitions collected from all loaded organs. */
	readonly tools: ToolDefinition[] = [];
	/** Organs stored for lazy port detection in validate(). */
	private readonly _organs: Organ[] = [];
	/** Loaded organs in mount order. Includes metadata (description, labels). */
	get organs(): readonly Organ[] {
		return this._organs;
	}
	private disposed = false;

	/**
	 * Load an organ onto the agent.
	 * Always calls mount() exactly once - port detection is deferred to validate().
	 */
	load(organ: Organ): this {
		if (this.disposed) throw new Error("Agent is disposed - cannot load organs.");
		this._organs.push(organ);
		const unmount = organ.mount(withPayloadValidation(this.nerve.asNerve(), organ));
		this.unmounts.push(unmount);
		this.tools.push(...organ.tools);
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
				.filter((o) => typeof o.ready === "function")
				.map((o) =>
					o.ready!().catch((err: unknown) => {
						throw new Error(`Agent.ready: organ '${o.name}' failed: ${String(err)}`);
					}),
				),
		);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unmount of this.unmounts) unmount();
		this.unmounts.length = 0;
	}
}
