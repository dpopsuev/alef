/**
 * Package Manager discover + Hub bus createView tests.
 *
 * Tests:
 *   1. PM discover registers services on supervisor
 *   2. Hub bus createView scopes events by correlationId prefix
 *   3. Hub bus view notifications pass through unfiltered
 */

import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createPackageManagerDescriptor, type DiscoveredService } from "@dpopsuev/alef-supervisor/package-manager";
import { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";
import { afterEach, describe, expect, it } from "vitest";

describe("Package Manager discover", { tags: ["unit"] }, () => {
	const supervisors: Supervisor[] = [];

	afterEach(async () => {
		for (const s of supervisors.splice(0)) await s.stopAll().catch(() => {});
	});

	it("PM.start() discovers services and registers them on supervisor", async () => {
		const stubService: ServiceDescriptor = {
			name: "stub-tool",
			restart: "permanent",
			shareable: true,
			create(_opts: ServiceCreateOpts): Promise<ManagedService> {
				return Promise.resolve({
					name: "stub-tool",
					restart: "permanent" as const,
					adapters: [],
					tools: [],
					start: () => Promise.resolve(),
					stop: () => Promise.resolve(),
					health: () => Promise.resolve(true),
				});
			},
		};

		const discovered: DiscoveredService[] = [{ name: "stub-tool", descriptor: stubService }];

		const supervisor = new Supervisor();
		supervisors.push(supervisor);
		supervisor.register(
			createPackageManagerDescriptor({
				discover: async () => discovered,
			}),
		);

		await supervisor.startAll({ cwd: "/tmp" });

		// PM discovered and registered the stub-tool
		expect(supervisor.names()).toContain("pm");
		// The stub-tool descriptor was registered but not started
		// (startAll only starts what was registered before it was called)
		// A second startAll would start it
		await supervisor.startAll({ cwd: "/tmp" });
		expect(supervisor.get("stub-tool")).toBeDefined();
	});

	it("PM with empty discover registers nothing extra", async () => {
		const supervisor = new Supervisor();
		supervisors.push(supervisor);
		supervisor.register(
			createPackageManagerDescriptor({
				discover: async () => [],
			}),
		);

		await supervisor.startAll({ cwd: "/tmp" });

		expect(supervisor.names()).toEqual(["pm"]);
	});
});

describe("Hub bus createView", { tags: ["unit"] }, () => {
	it("view scopes command events by correlationId prefix", () => {
		const hub = new InProcessBus();
		const view = hub.createView("agent-1");

		const hubEvents: string[] = [];
		const viewEvents: string[] = [];

		// Subscribe on hub — sees everything
		hub.subscribe("command", "test.cmd", (e) => {
			hubEvents.push(e.correlationId);
		});

		// Subscribe on view — only sees view-scoped events
		view.command.subscribe("test.cmd", (e) => {
			viewEvents.push(e.correlationId);
		});

		// Publish from view — should be prefixed
		view.command.publish({ type: "test.cmd", payload: {}, correlationId: "req-1" });

		// Publish from hub directly — no prefix
		hub.publish("command", { type: "test.cmd", payload: {}, correlationId: "other" });

		expect(hubEvents).toHaveLength(2);
		expect(hubEvents[0]).toBe("agent-1:req-1");
		expect(hubEvents[1]).toBe("other");

		// View only sees its own prefixed events
		expect(viewEvents).toHaveLength(1);
		expect(viewEvents[0]).toBe("agent-1:req-1");
	});

	it("view scopes event channel by correlationId prefix", () => {
		const hub = new InProcessBus();
		const view = hub.createView("agent-2");

		const viewEvents: string[] = [];
		view.event.subscribe("test.result", (e) => {
			viewEvents.push(e.correlationId);
		});

		// Publish from view — prefixed
		view.event.publish({
			type: "test.result",
			payload: {},
			correlationId: "req-2",
			isError: false,
		});

		// Publish from hub — not prefixed, view shouldn't see it
		hub.publish("event", {
			type: "test.result",
			payload: {},
			correlationId: "other",
			isError: false,
		});

		expect(viewEvents).toHaveLength(1);
		expect(viewEvents[0]).toBe("agent-2:req-2");
	});

	it("notifications pass through unfiltered (broadcast)", () => {
		const hub = new InProcessBus();
		const viewA = hub.createView("a");
		const viewB = hub.createView("b");

		const eventsA: string[] = [];
		const eventsB: string[] = [];

		viewA.notification.subscribe("alert", (e) => {
			eventsA.push(e.type);
		});
		viewB.notification.subscribe("alert", (e) => {
			eventsB.push(e.type);
		});

		// Publish notification from hub
		hub.publish("notification", { type: "alert", payload: {}, correlationId: "sys" });

		// Both views receive it
		expect(eventsA).toEqual(["alert"]);
		expect(eventsB).toEqual(["alert"]);
	});

	it("two views are isolated from each other's commands", () => {
		const hub = new InProcessBus();
		const viewA = hub.createView("alice");
		const viewB = hub.createView("bob");

		const eventsA: string[] = [];
		const eventsB: string[] = [];

		viewA.command.subscribe("msg", (e) => {
			eventsA.push(e.correlationId);
		});
		viewB.command.subscribe("msg", (e) => {
			eventsB.push(e.correlationId);
		});

		viewA.command.publish({ type: "msg", payload: {}, correlationId: "c1" });
		viewB.command.publish({ type: "msg", payload: {}, correlationId: "c2" });

		expect(eventsA).toEqual(["alice:c1"]);
		expect(eventsB).toEqual(["bob:c2"]);
	});
});
