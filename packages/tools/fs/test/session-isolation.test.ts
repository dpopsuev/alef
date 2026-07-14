import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsAdapter } from "../src/adapter.js";
import type { Bus, EventMessage } from "@dpopsuev/alef-kernel/bus";
import { InProcessBus } from "@dpopsuev/alef-kernel/bus";

/**
 * Session isolation tests for fs adapter.
 * Verify that sessions have independent watch/event state and cleanup properly.
 */
describe("fs session isolation", { tags: ["unit"] }, () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "alef-fs-session-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("sessions with different sessionIds have isolated watch state", async () => {
		const busA = new InProcessBus().asBus();
		const busB = new InProcessBus().asBus();

		const adapterA = createFsAdapter({ cwd: tempDir, sessionId: "session-a" });
		const adapterB = createFsAdapter({ cwd: tempDir, sessionId: "session-b" });

		const unmountA = adapterA.mount(busA);
		const unmountB = adapterB.mount(busB);

		const testFile = join(tempDir, "shared.txt");
		writeFileSync(testFile, "initial\n");

		// Session A creates a watch
		const watchResultA = await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = busA.event.subscribe("fs.watch", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			busA.command.publish({
				type: "fs.watch",
				correlationId: "test-a",
				payload: { path: testFile, debounceMs: 50 },
			});
		});

		expect(watchResultA.watchId).toBeDefined();
		const watchIdA = watchResultA.watchId as string;

		// Session B creates its own watch on the same file
		const watchResultB = await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = busB.event.subscribe("fs.watch", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			busB.command.publish({
				type: "fs.watch",
				correlationId: "test-b",
				payload: { path: testFile, debounceMs: 50 },
			});
		});

		expect(watchResultB.watchId).toBeDefined();
		const watchIdB = watchResultB.watchId as string;

		// WatchIds should be different
		expect(watchIdA).not.toBe(watchIdB);

		unmountA();
		unmountB();
	});

	it("timeline queries filter by sessionId", async () => {
		const busA = new InProcessBus().asBus();
		const busB = new InProcessBus().asBus();

		const adapterA = createFsAdapter({ cwd: tempDir, sessionId: "session-a" });
		const adapterB = createFsAdapter({ cwd: tempDir, sessionId: "session-b" });

		const unmountA = adapterA.mount(busA);
		const unmountB = adapterB.mount(busB);

		const testFile = join(tempDir, "test.txt");
		writeFileSync(testFile, "initial\n");

		// Session A creates a watch
		const watchResultA = await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = busA.event.subscribe("fs.watch", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			busA.command.publish({
				type: "fs.watch",
				correlationId: "test-a",
				payload: { path: testFile, debounceMs: 50 },
			});
		});

		const watchIdA = watchResultA.watchId as string;

		// Modify file (triggers event for session A)
		await new Promise((r) => setTimeout(r, 100));
		appendFileSync(testFile, "session A change\n");
		await new Promise((r) => setTimeout(r, 200));

		// Session A queries timeline - should see the event
		const timelineA = await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = busA.event.subscribe("fs.timeline", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			busA.command.publish({
				type: "fs.timeline",
				correlationId: "test-a-timeline",
				payload: { path: testFile },
			});
		});

		const eventsA = timelineA.events as Array<{ sessionId?: string; type: string }>;
		expect(eventsA.length).toBeGreaterThan(0);
		expect(eventsA.every((e) => e.sessionId === "session-a")).toBe(true);

		// Session B queries timeline - should NOT see session A's events
		const timelineB = await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = busB.event.subscribe("fs.timeline", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			busB.command.publish({
				type: "fs.timeline",
				correlationId: "test-b-timeline",
				payload: { path: testFile },
			});
		});

		const eventsB = timelineB.events as Array<{ sessionId?: string }>;
		expect(eventsB.length).toBe(0); // Session B has no events

		// Cleanup
		await new Promise<void>((resolve) => {
			const unsub = busA.event.subscribe("fs.unwatch", () => {
				unsub();
				resolve();
			});
			busA.command.publish({
				type: "fs.unwatch",
				correlationId: "cleanup-a",
				payload: { watchId: watchIdA },
			});
		});

		unmountA();
		unmountB();
	});

	it("unmounting adapter cleans up session-specific watches", async () => {
		const busA = new InProcessBus().asBus();
		const adapterA = createFsAdapter({ cwd: tempDir, sessionId: "session-a" });

		const unmountA = adapterA.mount(busA);

		const testFile = join(tempDir, "cleanup-test.txt");
		writeFileSync(testFile, "initial\n");

		// Create watch
		await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = busA.event.subscribe("fs.watch", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			busA.command.publish({
				type: "fs.watch",
				correlationId: "test-cleanup",
				payload: { path: testFile, debounceMs: 50 },
			});
		});

		// Track file events
		const fileEvents: EventMessage[] = [];
		const unsub = busA.event.subscribe("file.modified", (event) => {
			fileEvents.push(event);
		});

		await new Promise((r) => setTimeout(r, 100));
		appendFileSync(testFile, "before unmount\n");
		await new Promise((r) => setTimeout(r, 200));

		const eventsBeforeUnmount = fileEvents.length;
		expect(eventsBeforeUnmount).toBeGreaterThan(0);

		// Unmount should clean up watches
		unmountA();

		// Modify file after unmount - should NOT trigger events
		await new Promise((r) => setTimeout(r, 100));
		appendFileSync(testFile, "after unmount\n");
		await new Promise((r) => setTimeout(r, 200));

		expect(fileEvents.length).toBe(eventsBeforeUnmount); // No new events

		unsub();
	});

	it("adapter without sessionId operates in global mode (backward compat)", async () => {
		const bus = new InProcessBus().asBus();
		const adapter = createFsAdapter({ cwd: tempDir }); // No sessionId

		const unmount = adapter.mount(bus);

		const testFile = join(tempDir, "global.txt");
		writeFileSync(testFile, "initial\n");

		// Create watch
		const watchResult = await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = bus.event.subscribe("fs.watch", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			bus.command.publish({
				type: "fs.watch",
				correlationId: "test-global",
				payload: { path: testFile, debounceMs: 50 },
			});
		});

		expect(watchResult.watchId).toBeDefined();
		const watchId = watchResult.watchId as string;

		await new Promise((r) => setTimeout(r, 100));
		appendFileSync(testFile, "change\n");
		await new Promise((r) => setTimeout(r, 200));

		// Timeline should work without sessionId filter
		const timeline = await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = bus.event.subscribe("fs.timeline", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			bus.command.publish({
				type: "fs.timeline",
				correlationId: "test-global-timeline",
				payload: { path: testFile },
			});
		});

		const events = timeline.events as Array<{ type: string }>;
		expect(events.length).toBeGreaterThan(0);

		// Cleanup
		await new Promise<void>((resolve) => {
			const unsub = bus.event.subscribe("fs.unwatch", () => {
				unsub();
				resolve();
			});
			bus.command.publish({
				type: "fs.unwatch",
				correlationId: "cleanup-global",
				payload: { watchId },
			});
		});

		unmount();
	});

	it("context.assemble injects file events for session", async () => {
		const bus = new InProcessBus().asBus();
		const adapter = createFsAdapter({ cwd: tempDir, sessionId: "session-ctx" });

		const unmount = adapter.mount(bus);

		const testFile = join(tempDir, "context-test.txt");
		writeFileSync(testFile, "initial\n");

		// Create watch
		await new Promise<Record<string, unknown>>((resolve) => {
			const unsub = bus.event.subscribe("fs.watch", (event) => {
				if (!event.isError) {
					unsub();
					resolve(event.payload as Record<string, unknown>);
				}
			});
			bus.command.publish({
				type: "fs.watch",
				correlationId: "test-ctx",
				payload: { path: testFile, debounceMs: 50 },
			});
		});

		// Trigger file event
		await new Promise((r) => setTimeout(r, 100));
		appendFileSync(testFile, "context change\n");
		await new Promise((r) => setTimeout(r, 200));

		// Verify context.assemble handler exists and injects events
		// The handler is registered via contributions during mount
		const contributions = adapter.contributions;
		expect(contributions).toBeDefined();
		expect(contributions?.["context.assemble"]).toBeDefined();

		// Call the handler
		const handler = contributions?.["context.assemble"];
		if (handler) {
			const result = await handler({
				messages: [{ role: "system", content: "test" }],
				tools: [],
				turn: 1,
			});

			expect(result.messages).toBeDefined();
			// Messages should be injected (check length increased)
			expect(result.messages!.length).toBeGreaterThan(1);

			// Second call should return empty (events cleared)
			const result2 = await handler({
				messages: [{ role: "system", content: "test" }],
				tools: [],
				turn: 2,
			});

			// Should not inject again (events were cleared)
			expect(result2.messages === undefined || result2.messages.length === 1).toBe(true);
		}

		unmount();
	});
});
