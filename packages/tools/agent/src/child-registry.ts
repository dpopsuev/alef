import { rmSync } from "node:fs";
import type { ChildEntry } from "./child-process.js";

export interface ChildRegistryCallbacks {
	onReaped?(name: string, reason: string, exitCode?: number): void;
}

export class ChildRegistry {
	private readonly entries = new Map<string, ChildEntry>();
	private seq = 0;

	constructor(private readonly callbacks: ChildRegistryCallbacks = {}) {}

	nextName(): string {
		return `child-${++this.seq}`;
	}

	register(entry: ChildEntry): void {
		this.entries.set(entry.name, entry);
		entry.process.once("exit", (code) => {
			this.entries.delete(entry.name);
			if (entry.tmpDir) rmSync(entry.tmpDir, { recursive: true, force: true });
			this.callbacks.onReaped?.(entry.name, "exited", code ?? undefined);
		});
	}

	get(name: string): ChildEntry | undefined {
		return this.entries.get(name);
	}

	remove(name: string): boolean {
		return this.entries.delete(name);
	}

	values(): ChildEntry[] {
		return [...this.entries.values()];
	}

	killAll(): void {
		for (const entry of this.entries.values()) {
			try {
				entry.process.kill("SIGTERM");
			} catch {
				// already dead
			}
		}
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}
