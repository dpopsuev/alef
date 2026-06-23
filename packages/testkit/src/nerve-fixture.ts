import { randomUUID } from "node:crypto";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { type EventMessage, InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { BusEventRecorder } from "./bus-event-recorder.js";

/**
 * NerveFixture — shared test harness for adapter integration tests.
 *
 * Replaces the makeNerve / publishCommand / waitForEvent triad that every
 * adapter test package copies independently. Provides:
 *
 * fixture.mount(adapter) mount + track for cleanup
 * fixture.call(type, payload) command publish → await event
 * fixture.callStreaming(type, payload) await isFinal event
 * fixture.observe() attach BusEventRecorder
 * fixture.dispose() unmount all mounted adapters
 *
 * call() subscribes before publishing — no race condition.
 */
export class NerveFixture {
	readonly nerve = new InProcessBus();
	private readonly unmounts: Array<() => void> = [];

	mount(adapter: Adapter): () => void {
		const unmount = adapter.mount(this.nerve.asBus());
		this.unmounts.push(unmount);
		return unmount;
	}

	/**
	 * Publish command/<type> and await the first matching event/<type>.
	 * Subscribes before publishing so no event is missed.
	 */
	call(
		type: string,
		payload: Record<string, unknown>,
		opts: { timeoutMs?: number; correlationId?: string } = {},
	): Promise<EventMessage> {
		const correlationId = opts.correlationId ?? randomUUID();
		const timeoutMs = opts.timeoutMs ?? 5_000;

		const resultPromise = new Promise<EventMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error(`NerveFixture.call timed out after ${timeoutMs}ms waiting for event/${type}`));
			}, timeoutMs);
			const off = this.nerve.asBus().event.subscribe(type, (event) => {
				if (event.correlationId !== correlationId) return;
				clearTimeout(timer);
				off();
				resolve(event);
			});
		});

		this.nerve.asBus().command.publish({ type, payload, correlationId });
		return resultPromise;
	}

	/**
	 * Publish command/<type> and await the final event response (isFinal:true or isError).
	 * Use for streaming adapters like shell.exec.
	 */
	callStreaming(
		type: string,
		payload: Record<string, unknown>,
		opts: { timeoutMs?: number; correlationId?: string } = {},
	): Promise<EventMessage> {
		const correlationId = opts.correlationId ?? randomUUID();
		const timeoutMs = opts.timeoutMs ?? 10_000;

		const resultPromise = new Promise<EventMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error(`NerveFixture.callStreaming timed out after ${timeoutMs}ms waiting for event/${type}`));
			}, timeoutMs);
			const off = this.nerve.asBus().event.subscribe(type, (event) => {
				if (event.correlationId !== correlationId) return;
				const payload = event.payload as { isFinal?: boolean };
				if (!event.isError && payload.isFinal !== true && payload.isFinal !== undefined) return;
				clearTimeout(timer);
				off();
				resolve(event);
			});
		});

		this.nerve.asBus().command.publish({ type, payload, correlationId });
		return resultPromise;
	}

	observe(): BusEventRecorder {
		const recorder = new BusEventRecorder();
		this.nerve.onAnyCommand((event) => recorder.onCommand(event));
		this.nerve.onAnyEvent((event) => recorder.onEvent(event));
		this.nerve.onAnyNotification((event) => recorder.onNotification?.(event));
		return recorder;
	}

	dispose(): void {
		for (const unmount of this.unmounts.splice(0)) unmount();
	}
}
