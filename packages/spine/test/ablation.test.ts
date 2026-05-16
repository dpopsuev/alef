/**
 * Organ ablation — defineOrgan filters actions by allowlist.
 *
 * When OrganOptions.actions is specified, only listed event types are mounted.
 * Ablated actions: never on the bus, never in tools[], never constructed.
 */

import { describe, expect, it } from "vitest";
import { InProcessNerve } from "../src/buses.js";
import { defineCorpusOrgan } from "../src/framework.js";

const READ_TOOL = { name: "fs.read", description: "Read", inputSchema: {} };
const WRITE_TOOL = { name: "fs.write", description: "Write", inputSchema: {} };
const EDIT_TOOL = { name: "fs.edit", description: "Edit", inputSchema: {} };

function makeFsOrgan(actions?: readonly string[]) {
	return defineCorpusOrgan(
		"fs",
		{
			"fs.read": { tool: READ_TOOL, handle: async () => ({ content: "ok" }) },
			"fs.write": { tool: WRITE_TOOL, handle: async () => ({ path: "ok" }) },
			"fs.edit": { tool: EDIT_TOOL, handle: async () => ({ path: "ok" }) },
		},
		{ actions },
	);
}

describe("organ ablation — no filter (default)", () => {
	it("mounts all actions when no allowlist is specified", () => {
		const nerve = new InProcessNerve();
		const organ = makeFsOrgan();
		organ.mount(nerve.asNerve());

		expect(nerve.listenerCount("motor", "fs.read")).toBe(1);
		expect(nerve.listenerCount("motor", "fs.write")).toBe(1);
		expect(nerve.listenerCount("motor", "fs.edit")).toBe(1);
	});

	it("exposes all tools when no allowlist is specified", () => {
		const organ = makeFsOrgan();
		expect(organ.tools.map((t) => t.name)).toEqual(["fs.read", "fs.write", "fs.edit"]);
	});
});

describe("organ ablation — read-only allowlist", () => {
	it("mounts only allowed actions on the bus", () => {
		const nerve = new InProcessNerve();
		const organ = makeFsOrgan(["fs.read"]);
		organ.mount(nerve.asNerve());

		expect(nerve.listenerCount("motor", "fs.read")).toBe(1);
		expect(nerve.listenerCount("motor", "fs.write")).toBe(0); // ablated
		expect(nerve.listenerCount("motor", "fs.edit")).toBe(0); // ablated
	});

	it("exposes only allowed tools", () => {
		const organ = makeFsOrgan(["fs.read"]);
		expect(organ.tools.map((t) => t.name)).toEqual(["fs.read"]);
	});

	it("ablated action motor event finds no handler", async () => {
		const nerve = new InProcessNerve();
		const organ = makeFsOrgan(["fs.read"]);
		organ.mount(nerve.asNerve());

		const received: string[] = [];
		nerve.onAnySense((e) => received.push(e.type));

		nerve.asNerve().motor.publish({
			type: "fs.write",
			payload: { path: "x.ts", content: "bad" },
			correlationId: "c1",
			timestamp: Date.now(),
		});

		await new Promise((r) => setTimeout(r, 10));
		expect(received).toHaveLength(0); // no handler → no Sense event
	});

	it("allowed action still dispatches correctly", async () => {
		const nerve = new InProcessNerve();
		const organ = makeFsOrgan(["fs.read"]);
		organ.mount(nerve.asNerve());

		const events: string[] = [];
		nerve.onAnySense((e) => events.push(e.type));

		nerve.asNerve().motor.publish({
			type: "fs.read",
			payload: { path: "x.ts" },
			correlationId: "c1",
			timestamp: Date.now(),
		});

		await new Promise((r) => setTimeout(r, 20));
		expect(events).toContain("fs.read"); // handler fired
	});
});

describe("organ ablation — subscriptions reflect allowlist", () => {
	it("subscriptions only contains allowed motor events", () => {
		const organ = makeFsOrgan(["fs.read", "fs.grep"]);
		expect(organ.subscriptions.motor).toEqual(["fs.read"]);
		// fs.grep not in action map → ignored (unknown names are safe)
	});

	it("unknown names in allowlist are silently ignored", () => {
		const organ = makeFsOrgan(["fs.read", "fs.nonexistent"]);
		expect(organ.tools.map((t) => t.name)).toEqual(["fs.read"]);
	});

	it("empty allowlist mounts nothing", () => {
		const nerve = new InProcessNerve();
		const organ = makeFsOrgan([]);
		organ.mount(nerve.asNerve());

		expect(organ.tools).toHaveLength(0);
		expect(nerve.listenerCount("motor", "fs.read")).toBe(0);
		expect(nerve.listenerCount("motor", "fs.write")).toBe(0);
	});
});
