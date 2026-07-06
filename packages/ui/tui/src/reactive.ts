/**
 * Reactive store — observable state with batched notifications.
 *
 * Components subscribe to state changes. When state is updated,
 * listeners are notified on the next microtask (batched).
 *
 * Prior art: Solid.js createSignal, Svelte $state, Textual reactive,
 * BubbleTea Elm messages. This is the simplest correct pattern:
 * observable store with change detection + microtask batching.
 *
 * Usage:
 *   const store = new Store({ count: 0, name: "" });
 *   store.subscribe(() => component.invalidate());
 *   store.update({ count: 1 });        // batched notification
 *   store.update({ name: "alef" });     // same microtask — one notify
 */

/**
 *
 */
export class Store<T extends Record<string, unknown>> {
	private state: T;
	private readonly listeners = new Set<() => void>();
	private pendingNotify = false;

	constructor(initial: T) {
		this.state = { ...initial };
	}

	get(): Readonly<T> {
		return this.state;
	}

	select<K extends keyof T>(key: K): T[K] {
		return this.state[key];
	}

	update(partial: Partial<T>): void {
		let changed = false;
		for (const key of Object.keys(partial) as (keyof T)[]) {
			if (this.state[key] !== partial[key]) {
				changed = true;
				break;
			}
		}
		if (!changed) return;
		this.state = { ...this.state, ...partial };
		this.scheduleNotify();
	}

	set(next: T): void {
		this.state = { ...next };
		this.scheduleNotify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private scheduleNotify(): void {
		if (this.pendingNotify) return;
		this.pendingNotify = true;
		queueMicrotask(() => {
			this.pendingNotify = false;
			for (const l of this.listeners) l();
		});
	}
}

/**
 * Derived store — computes a value from one or more source stores.
 * Re-computes when any source notifies.
 *
 * Usage:
 *   const fullName = derived([firstName, lastName], (f, l) => `${f.get().name} ${l.get().name}`);
 *   fullName.subscribe(() => render(fullName.get()));
 */
export class Derived<T> {
	private value: T;
	private readonly listeners = new Set<() => void>();
	private readonly unsubs: Array<() => void> = [];

	constructor(
		sources: Array<{ subscribe(fn: () => void): () => void }>,
		compute: () => T,
	) {
		this.value = compute();
		for (const source of sources) {
			this.unsubs.push(
				source.subscribe(() => {
					const next = compute();
					if (next !== this.value) {
						this.value = next;
						for (const l of this.listeners) l();
					}
				}),
			);
		}
	}

	get(): T {
		return this.value;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		for (const unsub of this.unsubs) unsub();
		this.unsubs.length = 0;
		this.listeners.clear();
	}
}
