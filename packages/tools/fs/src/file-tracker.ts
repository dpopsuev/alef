/** Tracks file reads and writes within a session to enforce read-before-edit and staleness checks. */
export class FileTracker {
	static readonly MAX_SIZE = 1_000;

	private readonly reads = new Map<string, number>();
	private readonly writes = new Map<string, number>();
	private readonly snapshots = new Map<string, string>();

	record(absolutePath: string): void {
		this.reads.delete(absolutePath);
		this.reads.set(absolutePath, Date.now());
		if (this.reads.size > FileTracker.MAX_SIZE) {
			const oldest = this.reads.keys().next().value;
			if (oldest !== undefined) this.reads.delete(oldest);
		}
	}

	recordWrite(absolutePath: string, previousContent?: string): void {
		this.writes.delete(absolutePath);
		this.writes.set(absolutePath, Date.now());
		if (previousContent !== undefined && !this.snapshots.has(absolutePath)) {
			this.snapshots.set(absolutePath, previousContent);
		}
		if (this.writes.size > FileTracker.MAX_SIZE) {
			const oldest = this.writes.keys().next().value;
			if (oldest !== undefined) {
				this.writes.delete(oldest);
				this.snapshots.delete(oldest);
			}
		}
	}

	lastReadAt(absolutePath: string): number | undefined {
		return this.reads.get(absolutePath);
	}

	modifiedFiles(): string[] {
		return [...this.writes.keys()];
	}

	getSnapshot(absolutePath: string): string | undefined {
		return this.snapshots.get(absolutePath);
	}

	get size(): number {
		return this.reads.size;
	}
}
