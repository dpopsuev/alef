import {
	type CerebrumOrgan,
	type CorpusOrgan,
	InProcessNerve,
	type NerveEvent,
	type ToolDefinition,
} from "@dpopsuev/alef-spine";

// Corpus event type constants
export const DIALOG_MESSAGE = "dialog.message" as const;

// ---------------------------------------------------------------------------
// BusObserver — full read access to the Nerve for observability tools.
// Used by BusEventRecorder in testkit. Not an organ — not routed.
// ---------------------------------------------------------------------------

export interface BusObserver {
	onMotorEvent(event: NerveEvent): void;
	onSenseEvent(event: NerveEvent): void;
	onSignalEvent(event: NerveEvent): void;
}

// ---------------------------------------------------------------------------
// Corpus — the composition root and external boundary of the agent.
//
// Responsibilities:
//  - Creates the Spine (InProcessNerve) and owns it exclusively.
//  - Loads organs: mounts them onto the correct Nerve view based on kind.
//    CerebrumOrgans (mutate agent) → CerebrumNerve (sense.subscribe, motor.publish)
//    CorpusOrgans  (mutate world)  → CorpusNerve  (motor.subscribe, sense.publish)
//  - Collects ToolDefinition from all loaded organs.
//  - observe(): attaches a BusObserver (e.g. BusEventRecorder in tests).
//  - dispose(): tears down all subscriptions cleanly.
// ---------------------------------------------------------------------------

/** Reserved for future Corpus configuration. */
export interface CorpusOptions {}

export class Corpus {
	private readonly nerve = new InProcessNerve();
	private readonly unmounts: Array<() => void> = [];
	/** Tool definitions collected from all loaded organs. */
	readonly tools: ToolDefinition[] = [];
	private disposed = false;

	/**
	 * Load a CerebrumOrgan or CorpusOrgan onto the Spine.
	 * Routes the correct Nerve view based on organ.kind.
	 */
	load(organ: CerebrumOrgan | CorpusOrgan): this {
		if (this.disposed) throw new Error("Corpus is disposed — cannot load organs.");
		const unmount =
			organ.kind === "cerebrum"
				? organ.mount(this.nerve.asCerebrumNerve())
				: organ.mount(this.nerve.asCorpusNerve());
		this.unmounts.push(unmount);
		this.tools.push(...organ.tools);
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
			this.nerve.onAnySignal((e) => {
				observer.onSignalEvent(e);
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
