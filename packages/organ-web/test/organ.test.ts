import type { SenseEvent } from "@dpopsuev/alef-spine";
import { InProcessNerve } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { createWebOrgan } from "../src/organ.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, corpus: nerve.asCorpusNerve(), cerebrum: nerve.asCerebrumNerve() };
}

function publishMotor(nerve: InProcessNerve, type: string, payload: Record<string, unknown>) {
	nerve.asCerebrumNerve().motor.publish({
		type,
		payload: { ...payload, toolCallId: `tc-${Math.random().toString(36).slice(2)}` },
		correlationId: "test-corr",
		timestamp: Date.now(),
	});
}

function waitSense(nerve: InProcessNerve, type: string): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const off = nerve.asCerebrumNerve().sense.subscribe(type, (e) => {
			off();
			resolve(e);
		});
	});
}

describe("WebOrgan", () => {
	it("has kind=corpus, name=web, and 4 tools", () => {
		const organ = createWebOrgan();
		expect(organ.kind).toBe("corpus");
		expect(organ.name).toBe("web");
		expect(organ.tools).toHaveLength(4);
		expect(organ.tools.map((t) => t.name)).toEqual(["web.fetch", "web.search", "web.crawl", "web.graph"]);
	});

	it("unmount removes all motor subscriptions", () => {
		const { nerve, corpus } = makeNerve();
		const unmount = createWebOrgan().mount(corpus);
		expect(nerve.listenerCount("motor", "web.fetch")).toBe(1);
		expect(nerve.listenerCount("motor", "web.search")).toBe(1);
		expect(nerve.listenerCount("motor", "web.crawl")).toBe(1);
		expect(nerve.listenerCount("motor", "web.graph")).toBe(1);
		unmount();
		expect(nerve.listenerCount("motor", "web.fetch")).toBe(0);
		expect(nerve.listenerCount("motor", "web.graph")).toBe(0);
	});

	it("web.fetch: missing url returns error", async () => {
		const { nerve, corpus } = makeNerve();
		const unmount = createWebOrgan().mount(corpus);
		const p = waitSense(nerve, "web.fetch");
		publishMotor(nerve, "web.fetch", {});
		const result = await p;
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toContain("url is required");
		unmount();
	});

	it("web.search: missing query returns error", async () => {
		const { nerve, corpus } = makeNerve();
		const unmount = createWebOrgan().mount(corpus);
		const p = waitSense(nerve, "web.search");
		publishMotor(nerve, "web.search", {});
		const result = await p;
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toContain("query is required");
		unmount();
	});

	it("web.crawl: missing url returns error", async () => {
		const { nerve, corpus } = makeNerve();
		const unmount = createWebOrgan().mount(corpus);
		const p = waitSense(nerve, "web.crawl");
		publishMotor(nerve, "web.crawl", {});
		const result = await p;
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toContain("url is required");
		unmount();
	});

	it("web.graph snapshot: empty graph returns nodes/edges arrays", async () => {
		const { nerve, corpus } = makeNerve();
		const unmount = createWebOrgan().mount(corpus);
		const p = waitSense(nerve, "web.graph");
		publishMotor(nerve, "web.graph", { action: "snapshot" });
		const result = await p;
		expect(result.isError).toBe(false);
		expect(result.payload).toHaveProperty("nodes");
		expect(result.payload).toHaveProperty("edges");
		unmount();
	});

	it("web.graph rank: empty graph returns empty array", async () => {
		const { nerve, corpus } = makeNerve();
		const unmount = createWebOrgan().mount(corpus);
		const p = waitSense(nerve, "web.graph");
		publishMotor(nerve, "web.graph", { action: "rank", topN: 5 });
		const result = await p;
		expect(result.isError).toBe(false);
		expect(Array.isArray(result.payload.rank)).toBe(true);
		unmount();
	});

	it("web.graph unknown action returns error", async () => {
		const { nerve, corpus } = makeNerve();
		const unmount = createWebOrgan().mount(corpus);
		const p = waitSense(nerve, "web.graph");
		publishMotor(nerve, "web.graph", { action: "explode" });
		const result = await p;
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toContain("unknown action");
		unmount();
	});

	it("web.graph path: missing url/target returns error", async () => {
		const { nerve, corpus } = makeNerve();
		const unmount = createWebOrgan().mount(corpus);
		const p = waitSense(nerve, "web.graph");
		publishMotor(nerve, "web.graph", { action: "path" });
		const result = await p;
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toContain("url and target");
		unmount();
	});

	it("toolCallId is mirrored in Sense payload", async () => {
		const { nerve, corpus } = makeNerve();
		const unmount = createWebOrgan().mount(corpus);
		const p = waitSense(nerve, "web.graph");
		const correlationId = "corr-abc";
		nerve.asCerebrumNerve().motor.publish({
			type: "web.graph",
			payload: { action: "snapshot", toolCallId: "tc-xyz" },
			correlationId,
			timestamp: Date.now(),
		});
		const result = await p;
		expect(result.payload.toolCallId).toBe("tc-xyz");
		expect(result.correlationId).toBe(correlationId);
		unmount();
	});
});
