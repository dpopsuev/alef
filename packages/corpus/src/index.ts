import { randomUUID } from "node:crypto";
import {
	type CerebrumOrgan,
	type CorpusOrgan,
	InProcessNerve,
	type NerveEvent,
	type ToolDefinition,
} from "@dpopsuev/alef-spine";

// Corpus event type constants
export const MOTOR_TEXT_INPUT = "text.input" as const;
export const SENSE_TEXT_REPLY = "text.reply" as const;

// ---------------------------------------------------------------------------
// CorpusTimeoutError
// ---------------------------------------------------------------------------

export class CorpusTimeoutError extends Error {
	constructor(text: string, timeoutMs: number) {
		super(
			`Corpus.prompt() timed out after ${timeoutMs}ms. ` +
				`Prompt: "${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`,
		);
		this.name = "CorpusTimeoutError";
	}
}

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
//  - Collects ToolDefinition from all loaded organs for LLMOrgan's prompts.
//  - prompt(): injects Motor/"text.input", awaits Sense/"text.reply".
//  - observe(): attaches a BusObserver (e.g. BusEventRecorder in tests).
//  - dispose(): tears down all subscriptions cleanly.
// ---------------------------------------------------------------------------

export interface CorpusOptions {
	timeoutMs?: number;
}

export class Corpus {
	private readonly nerve = new InProcessNerve();
	private readonly unmounts: Array<() => void> = [];
	private readonly tools: ToolDefinition[] = [];
	private disposed = false;
	private readonly defaultTimeoutMs: number;

	constructor(options: CorpusOptions = {}) {
		this.defaultTimeoutMs = options.timeoutMs ?? 30_000;
	}

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

	/**
	 * Send a text prompt into the Corpus.
	 * Publishes Motor/"text.input" with the current tool list,
	 * then awaits Sense/"text.reply" with the matching correlationId.
	 */
	prompt(text: string, options: { timeoutMs?: number } = {}): Promise<string> {
		if (this.disposed) return Promise.reject(new Error("Corpus is disposed."));

		const correlationId = randomUUID();
		const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

		return new Promise<string>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let off: (() => void) | undefined;

			const cleanup = () => {
				off?.();
				if (timer !== undefined) clearTimeout(timer);
			};

			// Subscribe BEFORE emitting to avoid missing an immediate reply.
			off = this.nerve.subscribeSense("text.reply", (event) => {
				if (event.correlationId === correlationId) {
					cleanup();
					const text = typeof event.payload.text === "string" ? event.payload.text : "";
					resolve(text);
				}
			});

			timer = setTimeout(() => {
				cleanup();
				reject(new CorpusTimeoutError(text, timeoutMs));
			}, timeoutMs);

			this.nerve.publishMotor({
				type: "text.input",
				payload: { text, tools: [...this.tools] },
				correlationId,
				timestamp: Date.now(),
			});
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unmount of this.unmounts) unmount();
		this.unmounts.length = 0;
	}
}
