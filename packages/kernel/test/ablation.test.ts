/**
 * Adapter ablation — defineAdapter filters actions by allowlist.
 *
 * When AdapterOptions.actions is specified, only listed event types are mounted.
 * Ablated actions: never on the bus, never in tools[], never constructed.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAdapter } from "../src/framework.js";
import { InProcessNerve } from "../src/in-process-nerve.js";

const READ_TOOL = { name: "fs.read", description: "Read", inputSchema: z.object({}) };
const WRITE_TOOL = { name: "fs.write", description: "Write", inputSchema: z.object({}) };
const EDIT_TOOL = { name: "fs.edit", description: "Edit", inputSchema: z.object({}) };

function makeFsAdapter(actions?: readonly string[]) {
	return defineAdapter(
		"fs",
		{
			command: {
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
			description: "File system adapter stub for ablation tests.",
			directives: ["Use these tools to read, write, and edit files."],
		},
	);
}

describe("adapter ablation — no filter (default)", { tags: ["unit"] }, () => {
	it("mounts all actions when no allowlist is specified", () => {
		const nerve = new InProcessNerve();
		const adapter = makeFsAdapter();
		adapter.mount(nerve.asBus());

		expect(nerve.listenerCount("command", "fs.read")).toBe(1);
		expect(nerve.listenerCount("command", "fs.write")).toBe(1);
		expect(nerve.listenerCount("command", "fs.edit")).toBe(1);
	});

	it("exposes all tools when no allowlist is specified", () => {
		const adapter = makeFsAdapter();
		expect(adapter.tools.map((t: { name: string }) => t.name)).toEqual(["fs.read", "fs.write", "fs.edit"]);
	});
});

describe("adapter ablation — read-only allowlist", { tags: ["unit"] }, () => {
	it("mounts only allowed actions on the bus", () => {
		const nerve = new InProcessNerve();
		const adapter = makeFsAdapter(["fs.read"]);
		adapter.mount(nerve.asBus());

		expect(nerve.listenerCount("command", "fs.read")).toBe(1);
		expect(nerve.listenerCount("command", "fs.write")).toBe(0); // ablated
		expect(nerve.listenerCount("command", "fs.edit")).toBe(0); // ablated
	});

	it("exposes only allowed tools", () => {
		const adapter = makeFsAdapter(["fs.read"]);
		expect(adapter.tools.map((t: { name: string }) => t.name)).toEqual(["fs.read"]);
	});

	it("ablated action command message finds no handler", async () => {
		const nerve = new InProcessNerve();
		const adapter = makeFsAdapter(["fs.read"]);
		adapter.mount(nerve.asBus());

		const received: string[] = [];
		nerve.onAnyEvent((e) => received.push(e.type));

		nerve.asBus().command.publish({
			type: "fs.write",
			payload: { path: "x.ts", content: "bad" },
			correlationId: "c1",
		});

		await new Promise((r) => setTimeout(r, 10));
		// Dead letter detection: ablated command message produces an error event response.
		expect(received).toHaveLength(1);
		expect(received[0]).toBe("fs.write");
	});

	it("allowed action still dispatches correctly", async () => {
		const nerve = new InProcessNerve();
		const adapter = makeFsAdapter(["fs.read"]);
		adapter.mount(nerve.asBus());

		const events: string[] = [];
		nerve.onAnyEvent((e) => events.push(e.type));

		nerve.asBus().command.publish({
			type: "fs.read",
			payload: { path: "x.ts" },
			correlationId: "c1",
		});

		await new Promise((r) => setTimeout(r, 20));
		expect(events).toContain("fs.read"); // handler fired
	});
});

describe("adapter ablation — subscriptions reflect allowlist", { tags: ["unit"] }, () => {
	it("subscriptions only contains allowed command messages", () => {
		const adapter = makeFsAdapter(["fs.read", "fs.grep"]);
		expect(adapter.subscriptions.command).toEqual(["fs.read"]);
		// fs.grep not in action map → ignored (unknown names are safe)
	});

	it("unknown names in allowlist are silently ignored", () => {
		const adapter = makeFsAdapter(["fs.read", "fs.nonexistent"]);
		expect(adapter.tools.map((t: { name: string }) => t.name)).toEqual(["fs.read"]);
	});

	it("empty allowlist mounts nothing", () => {
		const nerve = new InProcessNerve();
		const adapter = makeFsAdapter([]);
		adapter.mount(nerve.asBus());

		expect(adapter.tools).toHaveLength(0);
		expect(nerve.listenerCount("command", "fs.read")).toBe(0);
		expect(nerve.listenerCount("command", "fs.write")).toBe(0);
	});
});
