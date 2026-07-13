/**
 * File watcher manager with debouncing and event emission.
 * Wraps Node.js fs.watch with path resolution and lifecycle management.
 */

import { watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FileEventType, TimelineEvent } from "./event-store.js";

/** Configuration options for starting a file watcher. */
export interface WatchOptions {
	glob: string;
	events?: readonly FileEventType[];
	recursive?: boolean;
	debounceMs?: number;
	duration?: number; // Auto-stop after ms
}

/** Handle returned by WatchManager.start() for controlling a watch subscription. */
export interface WatchHandle {
	watchId: string;
	active: boolean;
	glob: string;
	stop(): void;
}

type ChangeCallback = (event: TimelineEvent) => void;

interface ActiveWatch {
	watchId: string;
	path: string;
	options: WatchOptions;
	watcher: FSWatcher;
	callback: ChangeCallback;
	debounceTimers: Map<string, NodeJS.Timeout>;
	autoStopTimer?: NodeJS.Timeout;
}

/**
 * Manages file watchers with debouncing and automatic cleanup.
 * Each watch gets a unique ID for subscription tracking.
 */
export class WatchManager {
	private watches = new Map<string, ActiveWatch>();

	/**
	 * Start watching a path.
	 * Returns watchId for tracking and cleanup.
	 */
	start(absolutePath: string, options: WatchOptions, callback: ChangeCallback): WatchHandle {
		const watchId = randomUUID();
		const debounceMs = options.debounceMs ?? 100;

		const watcher = watch(
			absolutePath,
			{ recursive: options.recursive ?? true },
			(eventType, filename) => {
				if (!filename) return;

				const activeWatch = this.watches.get(watchId);
				if (!activeWatch) return;

				// Debounce: batch rapid changes
				const existingTimer = activeWatch.debounceTimers.get(filename);
				if (existingTimer) {
					clearTimeout(existingTimer);
				}

				// lint-ignore: RAWTIMER fs event debounce coalesces bursty inotify floods
				const timer = setTimeout(() => {
					activeWatch.debounceTimers.delete(filename);

					// Map fs.watch event types to our event types
					const type: FileEventType = eventType === "rename" ? "modified" : "modified";

					// Filter by requested event types
					if (options.events && !options.events.includes(type)) {
						return;
					}

					const event: TimelineEvent = {
						timestamp: Date.now(),
						type,
						path: `${absolutePath}/${filename}`,
						trigger: "external",
					};

					callback(event);
				}, debounceMs);

				activeWatch.debounceTimers.set(filename, timer);
			},
		);

		const activeWatch: ActiveWatch = {
			watchId,
			path: absolutePath,
			options,
			watcher,
			callback,
			debounceTimers: new Map(),
		};

		// Auto-stop after duration
		if (options.duration) {
			// lint-ignore: RAWTIMER watch auto-stop wall-clock deadline
			activeWatch.autoStopTimer = setTimeout(() => {
				this.stop(watchId);
			}, options.duration);
		}

		this.watches.set(watchId, activeWatch);

		return {
			watchId,
			active: true,
			glob: options.glob,
			stop: () => this.stop(watchId),
		};
	}

	/**
	 * Stop watching and clean up resources.
	 */
	stop(watchId: string): void {
		const activeWatch = this.watches.get(watchId);
		if (!activeWatch) return;

		// Clear debounce timers
		for (const timer of activeWatch.debounceTimers.values()) {
			clearTimeout(timer);
		}
		activeWatch.debounceTimers.clear();

		// Clear auto-stop timer
		if (activeWatch.autoStopTimer) {
			clearTimeout(activeWatch.autoStopTimer);
		}

		// Close watcher
		activeWatch.watcher.close();

		this.watches.delete(watchId);
	}

	/**
	 * Stop all active watchers (cleanup on unmount).
	 */
	stopAll(): void {
		for (const watchId of this.watches.keys()) {
			this.stop(watchId);
		}
	}

	/**
	 * Get info about active watches.
	 */
	getActive(): ReadonlyArray<{ watchId: string; path: string; glob: string }> {
		return Array.from(this.watches.values()).map((w) => ({
			watchId: w.watchId,
			path: w.path,
			glob: w.options.glob,
		}));
	}
}
