/**
 * Event history storage for file system changes.
 * Maintains a rolling window of events that can be queried via timeline API.
 */

/** File system event types emitted by watchers and recorded in timeline. */
export type FileEventType = "created" | "modified" | "deleted" | "renamed";

/** File system event record with timestamp, type, path, and optional metadata. */
export interface TimelineEvent {
	readonly timestamp: number;
	readonly type: FileEventType;
	readonly path: string;
	readonly oldPath?: string; // For rename events
	readonly size?: number; // File size after change
	readonly diff?: string; // Unified diff for modifications
	readonly trigger?: string; // What caused it: "fs.write", "fs.patch", "external"
}

/** Query parameters for filtering timeline events. */
export interface TimelineQuery {
	path?: string;
	since?: number;
	until?: number;
	events?: readonly FileEventType[];
	limit?: number;
}

/** Timeline query response with matching events and metadata. */
export interface TimelineResponse {
	events: readonly TimelineEvent[];
	total: number;
	oldest: number; // Timestamp of oldest retained event
}

/** Event store interface for recording and querying file system events. */
export interface EventStore {
	/** Append an event to the timeline */
	record(event: TimelineEvent): void;

	/** Query events matching filters */
	query(filters: TimelineQuery): TimelineResponse;

	/** Get current retention window info */
	retention(): { oldest: number; count: number };

	/** Prune events older than timestamp */
	prune(before: number): void;

	/** Clear all events */
	clear(): void;
}

/**
 * In-memory event store with configurable rolling window.
 * Events are retained based on both time (maxAge) and count (maxEvents).
 */
export class InMemoryEventStore implements EventStore {
	private events: TimelineEvent[] = [];
	private readonly maxEvents: number;
	private readonly maxAge: number;

	constructor(opts: { maxEvents?: number; maxAge?: number } = {}) {
		this.maxEvents = opts.maxEvents ?? 1000;
		this.maxAge = opts.maxAge ?? 3600_000; // 1 hour default
	}

	record(event: TimelineEvent): void {
		this.events.push(event);
		// Prune based on event timestamp, not wall clock (supports test timestamps)
		this.prune(event.timestamp - this.maxAge);
	}

	query(filters: TimelineQuery): TimelineResponse {
		let results = this.events;

		// Filter by path (exact match or prefix for directories)
		if (filters.path) {
			const targetPath = filters.path;
			results = results.filter(
				(e) =>
					e.path === targetPath ||
					e.path.startsWith(targetPath + "/") ||
					(e.oldPath && (e.oldPath === targetPath || e.oldPath.startsWith(targetPath + "/"))),
			);
		}

		// Filter by time range
		if (filters.since !== undefined) {
			results = results.filter((e) => e.timestamp >= filters.since!);
		}
		if (filters.until !== undefined) {
			results = results.filter((e) => e.timestamp <= filters.until!);
		}

		// Filter by event types
		if (filters.events && filters.events.length > 0) {
			const allowedTypes = new Set(filters.events);
			results = results.filter((e) => allowedTypes.has(e.type));
		}

		const total = results.length;

		// Apply limit (most recent events)
		const limit = filters.limit ?? 50;
		if (results.length > limit) {
			results = results.slice(-limit);
		}

		return {
			events: results,
			total,
			oldest: this.events[0]?.timestamp ?? Date.now(),
		};
	}

	retention(): { oldest: number; count: number } {
		return {
			oldest: this.events[0]?.timestamp ?? Date.now(),
			count: this.events.length,
		};
	}

	prune(before: number): void {
		this.events = this.events.filter((e) => e.timestamp >= before);

		// Also enforce max event count
		if (this.events.length > this.maxEvents) {
			this.events = this.events.slice(-this.maxEvents);
		}
	}

	clear(): void {
		this.events = [];
	}

	/** Get all events (for testing/debugging) */
	getAll(): readonly TimelineEvent[] {
		return this.events;
	}
}
