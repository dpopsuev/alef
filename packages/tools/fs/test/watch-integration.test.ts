import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsAdapter } from "../src/adapter.js";
import type { Bus, EventMessage } from "@dpopsuev/alef-kernel/bus";
import { InProcessBus } from "@dpopsuev/alef-kernel/bus";

/**
 * Integration test for reactive filesystem workflow:
 * 1. Agent calls fs.watch to start monitoring
 * 2. External process modifies file
 * 3. WatchManager detects change and emits file.* event to bus
 * 4. Event is recorded in timeline
 * 5. Agent can query fs.timeline to retrieve history
 * 6. Agent calls fs.unwatch to stop
 */
describe("fs watch integration", { tags: ["unit"] }, () => {
	let tempDir: string;
	let bus: Bus;
	let adapter: ReturnType<typeof createFsAdapter>;
	let unmount: (() => void) | undefined;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "alef-fs-watch-test-"));
		const processBus = new InProcessBus();
		bus = processBus.asBus();
		adapter = createFsAdapter({ cwd: tempDir });
		unmount = adapter.mount(bus);
	});

	afterAll(() => {
		unmount?.();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("watches file, detects changes, emits events, maintains queryable history", async () => {
		const testFile = join(tempDir, "watched.txt");
		writeFileSync(testFile, "initial content\n");

		// Track events emitted to the bus
		const emittedFileEvents: EventMessage[] = [];
		const fileEventUnsub = bus.event.subscribe("file.modified", (event) => {
			emittedFileEvents.push(event);
		});

		// Step 1: Start watching
		const watchResult = await new Promise<Record<string, unknown>>((resolve) => {
			// Listen for the result event
			const unsub = bus.event.subscribe("fs.watch", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			// Send command
			bus.command.publish({
				type: "fs.watch",
				correlationId: "test-1",
				payload: {
					path: testFile,
					debounceMs: 50, // Short debounce for fast test
				},
			});
		});

		expect(watchResult.watchId).toBeDefined();
		expect(typeof watchResult.watchId).toBe("string");
		const watchId = watchResult.watchId as string;

		// Step 2: Modify the file externally
		await new Promise((r) => setTimeout(r, 100)); // Let watcher settle
		appendFileSync(testFile, "new line\n");

		// Step 3: Wait for event emission (debounce + processing)
		await new Promise((r) => setTimeout(r, 200));

		// Verify event was emitted to bus
		expect(emittedFileEvents.length).toBeGreaterThan(0);
		const fileEvent = emittedFileEvents[0];
		expect(fileEvent?.type).toBe("file.modified");
		expect(fileEvent?.payload.watchId).toBe(watchId);
		expect(fileEvent?.payload.path).toContain("watched.txt");

		// Step 4: Query timeline
		const timelineResult = await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = bus.event.subscribe("fs.timeline", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			bus.command.publish({
				type: "fs.timeline",
				correlationId: "test-2",
				payload: {
					path: testFile,
				},
			});
		});

		expect(timelineResult.events).toBeDefined();
		const events = timelineResult.events as Array<{
			timestamp: number;
			type: string;
			path: string;
		}>;
		expect(events.length).toBeGreaterThan(0);
		
		const modifiedEvent = events.find((e) => e.type === "modified" && e.path.includes("watched.txt"));
		expect(modifiedEvent).toBeDefined();
		expect(modifiedEvent?.timestamp).toBeGreaterThan(0);

		// Step 5: Stop watching
		const unwatchResult = await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = bus.event.subscribe("fs.unwatch", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			bus.command.publish({
				type: "fs.unwatch",
				correlationId: "test-3",
				payload: {
					watchId,
				},
			});
		});

		expect(unwatchResult.stopped).toBe(true);

		// Step 6: Verify no more events after unwatch
		const beforeCount = emittedFileEvents.length;
		appendFileSync(testFile, "should not trigger event\n");
		await new Promise((r) => setTimeout(r, 200));
		expect(emittedFileEvents.length).toBe(beforeCount); // No new events

		fileEventUnsub();
	});

	it("timeline returns events in chronological order", async () => {
		const testFile = join(tempDir, "timeline-test.txt");
		writeFileSync(testFile, "v1\n");

		// Start watching
		const watchResult = await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = bus.event.subscribe("fs.watch", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			bus.command.publish({
				type: "fs.watch",
				correlationId: "timeline-1",
				payload: { path: testFile, debounceMs: 50 },
			});
		});
		const watchId = watchResult.watchId as string;

		await new Promise((r) => setTimeout(r, 100));

		// Make multiple changes
		appendFileSync(testFile, "v2\n");
		await new Promise((r) => setTimeout(r, 150));
		appendFileSync(testFile, "v3\n");
		await new Promise((r) => setTimeout(r, 150));

		// Query timeline
		const timelineResult = await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = bus.event.subscribe("fs.timeline", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			bus.command.publish({
				type: "fs.timeline",
				correlationId: "timeline-2",
				payload: { path: testFile },
			});
		});

		const events = timelineResult.events as Array<{ timestamp: number; type: string }>;
		expect(events.length).toBeGreaterThanOrEqual(2);

		// Verify chronological order
		for (let i = 1; i < events.length; i++) {
			expect(events[i]!.timestamp).toBeGreaterThanOrEqual(events[i - 1]!.timestamp);
		}

		// Cleanup
		await new Promise<void>((resolve) => {
			const unsub = bus.event.subscribe("fs.unwatch", (event) => {
				if (!event.isError) {
					unsub();
					resolve();
				}
			});
			bus.command.publish({
				type: "fs.unwatch",
				correlationId: "timeline-3",
				payload: { watchId },
			});
		});
	});

	it("filters timeline by event type", async () => {
		// Query for specific event types
		const timelineResult = await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = bus.event.subscribe("fs.timeline", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			bus.command.publish({
				type: "fs.timeline",
				correlationId: "filter-1",
				payload: {
					events: ["modified"],
				},
			});
		});

		const events = timelineResult.events as Array<{ type: string }>;
		// All returned events should be "modified"
		for (const event of events) {
			expect(event.type).toBe("modified");
		}
	});
});
