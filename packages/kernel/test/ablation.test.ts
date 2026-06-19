/**
 * Organ ablation — defineOrgan filters actions by allowlist.
 *
 * When OrganOptions.actions is specified, only listed event types are mounted.
 * Ablated actions: never on the bus, never in tools[], never constructed.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOrgan } from "../src/framework.js";
import { InProcessNerve } from "../src/in-process-nerve.js";

const READ_TOOL = { name: "fs.read", description: "Read", inputSchema: z.object({}) };
const WRITE_TOOL = { name: "fs.write", description: "Write", inputSchema: z.object({}) };
const EDIT_TOOL = { name: "fs.edit", description: "Edit", inputSchema: z.object({}) };

function makeFsOrgan(actions?: readonly string[]) {
	return defineOrgan(
		"fs",
		{
			motor: {
				"fs.read": {
					tool: READ_TOOL,
					async *handle() {
						yield { content: "ok" };
					},
				},
				"fs.write": {
					tool: WRITE_TOOL,
					async *handle() {
						yield { path: "ok" };
					},
				},
				"fs.edit": {
					tool: EDIT_TOOL,
					async *handle() {
						yield { path: "ok" };
					},
				},
			},
		},
		{
			actions,
			description: "File system organ stub for ablation tests.",
			directives: ["Use these tools to read, write, and edit files."],
		},
	);
}

describe("organ ablation — no filter (default)", { tags: ["unit"] }, () => {
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
		expect(organ.tools.map((t: { name: string }) => t.name)).toEqual(["fs.read", "fs.write", "fs.edit"]);
	});
});

describe("organ ablation — read-only allowlist", { tags: ["unit"] }, () => {
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
		expect(organ.tools.map((t: { name: string }) => t.name)).toEqual(["fs.read"]);
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
		});

		await new Promise((r) => setTimeout(r, 10));
		// Dead letter detection: ablated motor event produces an error sense response.
		expect(received).toHaveLength(1);
		expect(received[0]).toBe("fs.write");
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
		});

		await new Promise((r) => setTimeout(r, 20));
		expect(events).toContain("fs.read"); // handler fired
	});
});

describe("organ ablation — subscriptions reflect allowlist", { tags: ["unit"] }, () => {
	it("subscriptions only contains allowed motor events", () => {
		const organ = makeFsOrgan(["fs.read", "fs.grep"]);
		expect(organ.subscriptions.motor).toEqual(["fs.read"]);
		// fs.grep not in action map → ignored (unknown names are safe)
	});

	it("unknown names in allowlist are silently ignored", () => {
		const organ = makeFsOrgan(["fs.read", "fs.nonexistent"]);
		expect(organ.tools.map((t: { name: string }) => t.name)).toEqual(["fs.read"]);
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
