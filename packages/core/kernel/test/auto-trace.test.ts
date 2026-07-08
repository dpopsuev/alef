import { afterEach, describe, expect, it, vi } from "vitest";
import { InProcessBus } from "../src/bus/in-process-bus.js";
import { withAutoTrace } from "../src/bus/auto-trace.js";
import { initSessionSink } from "../src/trace.js";

describe("withAutoTrace bus middleware", { tags: ["unit"] }, () => {
	const events: Array<{ type: string; bus: string }> = [];

	afterEach(() => {
		events.splice(0);
		initSessionSink(() => {});
	});

	function setupTracedBus() {
		initSessionSink((record) => {
			events.push({ type: String(record.type), bus: String(record.bus) });
		});
		const raw = new InProcessBus();
		const bus = withAutoTrace()(raw.asBus());
		return bus;
	}

	it("traces command publish", () => {
		const bus = setupTracedBus();
		bus.command.publish({ type: "test.cmd", payload: { key: "val" }, correlationId: "c-1" });

		const traced = events.find((e) => e.type === "bus:command:test.cmd");
		expect(traced).toBeDefined();
	});

	it("traces notification publish", () => {
		const bus = setupTracedBus();
		bus.notification.publish({ type: "llm.chunk", payload: { text: "hi" }, correlationId: "c-1" });

		const traced = events.find((e) => e.type === "bus:notification:llm.chunk");
		expect(traced).toBeDefined();
	});

	it("traces event publish", () => {
		const bus = setupTracedBus();
		bus.event.publish({ type: "llm.input", payload: { text: "hello" }, correlationId: "c-1", isError: false });

		const traced = events.find((e) => e.type === "bus:event:llm.input");
		expect(traced).toBeDefined();
	});

	it("events still reach subscribers through the traced bus", () => {
		const bus = setupTracedBus();
		const received: string[] = [];
		bus.command.subscribe("test.echo", (e) => { received.push(e.type); });
		bus.command.publish({ type: "test.echo", payload: {}, correlationId: "c-1" });

		expect(received).toEqual(["test.echo"]);
	});
});
