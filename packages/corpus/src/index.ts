import { InProcessNerve, type NerveEvent, type Organ, type ToolDefinition } from "@dpopsuev/alef-spine";

// Corpus event type constants
export const DIALOG_MESSAGE = "dialog.message" as const;

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
	private disposed = false;

	/** Load an organ onto the agent. */
	load(organ: Organ): this {
		if (this.disposed) throw new Error("Agent is disposed — cannot load organs.");
		const unmount = organ.mount(this.nerve.asNerve());
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
