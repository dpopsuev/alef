import { randomUUID } from "node:crypto";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { type EventMessage, InProcessBus } from "@dpopsuev/alef-kernel/bus";

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * AdapterHarness — unit-level Command→Event test harness.
 *
 * Mounts a single adapter on an isolated InProcessBus and provides
 * a send() method that fires a command event and returns the matching
 * event response. Fails if no event response arrives within the timeout.
 *
 * Usage:
 *   const h = new AdapterHarness(createFsAdapter({ cwd }));
 *   await h.ready();
 *   const result = await h.send("fs.read", { path: "README.md" });
 *   expect(result.isError).toBe(false);
 *   h.dispose();
 */
export class AdapterHarness {
	private readonly nerve = new InProcessBus();
	private readonly unmount: () => void;
	private readonly adapter: Adapter;
	private readonly timeoutMs: number;

	constructor(adapter: Adapter, opts: { timeoutMs?: number } = {}) {
		this.adapter = adapter;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.unmount = adapter.mount(this.nerve.asBus());
	}

	async ready(): Promise<void> {
		await this.adapter.ready?.();
	}

	/**
	 * Send a command event and wait for the matching event response.
	 * Rejects with a clear error if no event response arrives within timeoutMs.
	 */
	send(type: string, payload: Record<string, unknown> = {}): Promise<EventMessage> {
		const correlationId = randomUUID();
		return new Promise<EventMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(
					new Error(
						`AdapterHarness: no event/${type} response within ${this.timeoutMs}ms. ` +
							`Adapter '${this.adapter.name}' may be hanging or not handling command/${type}.`,
					),
				);
			}, this.timeoutMs);

			const off = this.nerve.subscribe("event", type, (event) => {
				if (event.correlationId !== correlationId) return;
				clearTimeout(timer);
				off();
				resolve(event as EventMessage);
			});

			this.nerve.publish("command", { type, payload, correlationId });
		});
	}

	dispose(): void {
		this.unmount();
	}
}
