import {
	InProcessNerve,
	type NerveEvent,
	type Organ,
	type OrganPortInfo,
	type PortDefinition,
	PortValidationError,
	STANDARD_PORTS,
	type ToolDefinition,
	validatePorts,
} from "@dpopsuev/alef-spine";

// Corpus event type constants
export const DIALOG_MESSAGE = "dialog.message" as const;
export { PortValidationError, STANDARD_PORTS, validatePorts } from "@dpopsuev/alef-spine";

// ---------------------------------------------------------------------------
// BusObserver — full read access to the Nerve for observability tools.
// Used by BusEventRecorder in testkit. Not an organ — not routed.
// ---------------------------------------------------------------------------

export interface BusObserver {
	onMotorEvent(event: NerveEvent): void;
	onSenseEvent(event: NerveEvent): void;
}

// ---------------------------------------------------------------------------
// Corpus — the composition root and external boundary of the agent.
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
	private readonly organs: Organ[] = [];
	private disposed = false;

	/**
	 * Load an organ onto the agent.
	 * Always calls mount() exactly once — port detection is deferred to validate().
	 */
	load(organ: Organ): this {
		if (this.disposed) throw new Error("Agent is disposed — cannot load organs.");
		this.organs.push(organ);
		const unmount = organ.mount(this.nerve.asNerve());
		this.unmounts.push(unmount);
		this.tools.push(...organ.tools);
		return this;
	}

	/**
	 * Validate port cardinality. Call before the first dialog.send().
	 *
	 * Seam info is collected lazily here (not in load()) so that mount() is always
	 * called exactly once. For organs created with defineOrgan, subscriptions are
	 * read from organ.subscriptions (declared from the action map keys). For
	 * hand-crafted organs that don’t declare subscriptions, a throw-away probe nerve
	 * intercepts subscribe() calls to detect coverage — mount() is called once extra
	 * on that probe nerve only at validate() time.
	 *
	 * Throws PortValidationError on errors (missing/duplicate exactly-one ports).
	 * Logs warnings for zero-or-one violations.
	 */
	validate(seams: PortDefinition[] = STANDARD_PORTS): this {
		const infos: OrganPortInfo[] = this.organs.map((organ) => {
			if (organ.subscriptions) {
				return {
					name: organ.name,
					motorSubscriptions: [...(organ.subscriptions.motor ?? [])],
					senseSubscriptions: [...(organ.subscriptions.sense ?? [])],
				};
			}
			// Probe for hand-crafted organs without declared subscriptions.
			const motorSubs: string[] = [];
			const senseSubs: string[] = [];
			const probe = {
				motor: {
					subscribe: (type: string, _h: unknown) => {
						motorSubs.push(type);
						return () => {};
					},
					publish: () => {},
				},
				sense: {
					subscribe: (type: string, _h: unknown) => {
						senseSubs.push(type);
						return () => {};
					},
					publish: () => {},
				},
			};
			organ.mount(probe as never);
			return { name: organ.name, motorSubscriptions: motorSubs, senseSubscriptions: senseSubs };
		});

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

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unmount of this.unmounts) unmount();
		this.unmounts.length = 0;
	}
}
