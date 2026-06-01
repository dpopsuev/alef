import { randomUUID } from "node:crypto";
import type { Organ, SenseEvent } from "@dpopsuev/alef-spine";
import { InProcessNerve } from "@dpopsuev/alef-spine";

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * OrganHarness — unit-level Motor→Sense test harness.
 *
 * Mounts a single organ on an isolated InProcessNerve and provides
 * a send() method that fires a motor event and returns the matching
 * sense event. Fails if no sense event arrives within the timeout.
 *
 * Usage:
 *   const h = new OrganHarness(createFsOrgan({ cwd }));
 *   await h.ready();
 *   const sense = await h.send("fs.read", { path: "README.md" });
 *   expect(sense.isError).toBe(false);
 *   h.dispose();
 */
export class OrganHarness {
	private readonly nerve = new InProcessNerve();
	private readonly unmount: () => void;
	private readonly organ: Organ;
	private readonly timeoutMs: number;

	constructor(organ: Organ, opts: { timeoutMs?: number } = {}) {
		this.organ = organ;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.unmount = organ.mount(this.nerve.asNerve());
	}

	async ready(): Promise<void> {
		await this.organ.ready?.();
	}

	/**
	 * Send a motor event and wait for the matching sense event.
	 * Rejects with a clear error if no sense event arrives within timeoutMs.
	 */
	send(type: string, payload: Record<string, unknown> = {}): Promise<SenseEvent> {
		const correlationId = randomUUID();
		return new Promise<SenseEvent>((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(
					new Error(
						`OrganHarness: no sense/${type} event within ${this.timeoutMs}ms. ` +
							`Organ '${this.organ.name}' may be hanging or not handling motor/${type}.`,
					),
				);
			}, this.timeoutMs);

			const off = this.nerve.subscribeSense(type, (event) => {
				if (event.correlationId !== correlationId) return;
				clearTimeout(timer);
				off();
				resolve(event as SenseEvent);
			});

			this.nerve.publishMotor({ type, payload, correlationId });
		});
	}

	dispose(): void {
		this.unmount();
	}
}
