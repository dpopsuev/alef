import { randomUUID } from "node:crypto";
import { InProcessNerve, type Organ, type SenseEvent } from "@dpopsuev/alef-spine";
import { BusEventRecorder } from "./index.js";

/**
 * NerveFixture — shared test harness for organ integration tests.
 *
 * Replaces the makeNerve / publishMotor / waitForSense triad that every
 * organ test package copies independently. Provides:
 *
 *   fixture.mount(organ)                         mount + track for cleanup
 *   fixture.call(type, payload)                  motor publish → await sense
 *   fixture.callStreaming(type, payload)          await isFinal sense
 *   fixture.observe()                             attach BusEventRecorder
 *   fixture.dispose()                             unmount all mounted organs
 *
 * call() subscribes before publishing — no race condition (ALE-BUG-50).
 */
export class NerveFixture {
	readonly nerve = new InProcessNerve();
	private readonly unmounts: Array<() => void> = [];

	mount(organ: Organ): () => void {
		const unmount = organ.mount(this.nerve.asNerve());
		this.unmounts.push(unmount);
		return unmount;
	}

	/**
	 * Publish motor/<type> and await the first matching sense/<type>.
	 * Subscribes before publishing so no sense event is missed.
	 */
	call(
		type: string,
		payload: Record<string, unknown>,
		opts: { timeoutMs?: number; correlationId?: string } = {},
	): Promise<SenseEvent> {
		const correlationId = opts.correlationId ?? randomUUID();
		const timeoutMs = opts.timeoutMs ?? 5_000;

		const resultPromise = new Promise<SenseEvent>((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error(`NerveFixture.call timed out after ${timeoutMs}ms waiting for sense/${type}`));
			}, timeoutMs);
			const off = this.nerve.asNerve().sense.subscribe(type, (event) => {
				if (event.correlationId !== correlationId) return;
				clearTimeout(timer);
				off();
				resolve(event);
			});
		});

		this.nerve.asNerve().motor.publish({ type, payload, correlationId });
		return resultPromise;
	}

	/**
	 * Publish motor/<type> and await the final sense event (isFinal:true or isError).
	 * Use for streaming organs like shell.exec.
	 */
	callStreaming(
		type: string,
		payload: Record<string, unknown>,
		opts: { timeoutMs?: number; correlationId?: string } = {},
	): Promise<SenseEvent> {
		const correlationId = opts.correlationId ?? randomUUID();
		const timeoutMs = opts.timeoutMs ?? 10_000;

		const resultPromise = new Promise<SenseEvent>((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error(`NerveFixture.callStreaming timed out after ${timeoutMs}ms waiting for sense/${type}`));
			}, timeoutMs);
			const off = this.nerve.asNerve().sense.subscribe(type, (event) => {
				if (event.correlationId !== correlationId) return;
				const payload = event.payload as { isFinal?: boolean };
				if (!event.isError && payload.isFinal !== true && payload.isFinal !== undefined) return;
				clearTimeout(timer);
				off();
				resolve(event);
			});
		});

		this.nerve.asNerve().motor.publish({ type, payload, correlationId });
		return resultPromise;
	}

	observe(): BusEventRecorder {
		const recorder = new BusEventRecorder();
		this.nerve.onAnyMotor((event) => recorder.onMotorEvent(event));
		this.nerve.onAnySense((event) => recorder.onSenseEvent(event));
		return recorder;
	}

	dispose(): void {
		for (const unmount of this.unmounts.splice(0)) unmount();
	}
}
