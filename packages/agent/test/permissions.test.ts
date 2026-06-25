/**
 * Unit tests for wrapWithPermissions.
 */

import { wrapWithPermissions } from "@dpopsuev/alef-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

declare module "@dpopsuev/alef-kernel" {
	interface CommandMessageRegistry {
		"fs.read": { path: string; toolCallId: string };
		"fs.write": { path: string; content: string; toolCallId: string };
		"shell.exec": { command: string; toolCallId: string };
	}
	interface EventMessageRegistry {
		"fs.read": { content: string; toolCallId: string };
		"fs.write": { ok: boolean; toolCallId: string };
		"shell.exec": { output: string; toolCallId: string };
	}
}

function makePassthroughAdapter(name: string): Adapter {
	return {
		name,
		tools: [],
		subscriptions: { command: ["fs.read" as const, "fs.write" as const], event: [], notification: [] },
		sources: [],
		mount(bus) {
			const off1 = bus.command.subscribe("fs.read", (e) => {
				bus.event.publish({
					type: "fs.read",
					payload: { content: "data", toolCallId: e.payload.toolCallId },
					correlationId: e.correlationId,
					isError: false,
				});
			});
			const off2 = bus.command.subscribe("fs.write", (e) => {
				bus.event.publish({
					type: "fs.write",
					payload: { ok: true, toolCallId: e.payload.toolCallId },
					correlationId: e.correlationId,
					isError: false,
				});
			});
			return () => {
				off1();
				off2();
			};
		},
	};
}

function waitSense(bus: InProcessBus, type: string, correlationId: string) {
	return new Promise<import("@dpopsuev/alef-kernel").EventMessage>((resolve) => {
		const off = bus.asBus().event.subscribe(type, (e) => {
			if (e.correlationId === correlationId) {
				off();
				resolve(e);
			}
		});
	});
}

describe("wrapWithPermissions", { tags: ["unit"] }, () => {
	it("['*'] bypasses gate — all tools pass through", async () => {
		const bus = new InProcessBus();
		const adapter = wrapWithPermissions(makePassthroughAdapter("fs"), ["*"]);
		adapter.mount(bus.asBus());

		const corrId = "corr-yolo";
		const result = waitSense(bus, "fs.read", corrId);
		bus.asBus().command.publish({
			type: "fs.read",
			payload: { path: "a.ts", toolCallId: "tc1" },
			correlationId: corrId,
		});
		const ev = await result;
		expect(ev.isError).toBe(false);
	});

	it("allowed tool passes through to organ handler", async () => {
		const bus = new InProcessBus();
		const adapter = wrapWithPermissions(makePassthroughAdapter("fs"), ["fs.read"]);
		adapter.mount(bus.asBus());

		const corrId = "corr-allow";
		const result = waitSense(bus, "fs.read", corrId);
		bus.asBus().command.publish({
			type: "fs.read",
			payload: { path: "b.ts", toolCallId: "tc2" },
			correlationId: corrId,
		});
		const ev = await result;
		expect(ev.isError).toBe(false);
		expect((ev.payload as { content?: string }).content).toBe("data");
	});

	it("denied tool publishes isError sense event with permission message", async () => {
		const bus = new InProcessBus();
		const adapter = wrapWithPermissions(makePassthroughAdapter("fs"), ["fs.read"]);
		adapter.mount(bus.asBus());

		const corrId = "corr-deny";
		const result = waitSense(bus, "fs.write", corrId);
		bus.asBus().command.publish({
			type: "fs.write",
			payload: { path: "x.ts", content: "evil", toolCallId: "tc3" },
			correlationId: corrId,
		});
		const ev = await result;
		expect(ev.isError).toBe(true);
		expect(ev.errorMessage).toMatch(/Permission denied.*fs\.write/);
		expect(ev.errorMessage).toMatch(/allowed_tools/);
	});

	it("empty allowedTools denies everything", async () => {
		const bus = new InProcessBus();
		const adapter = wrapWithPermissions(makePassthroughAdapter("fs"), []);
		adapter.mount(bus.asBus());

		const corrId = "corr-empty";
		const result = waitSense(bus, "fs.read", corrId);
		bus.asBus().command.publish({
			type: "fs.read",
			payload: { path: "a.ts", toolCallId: "tc4" },
			correlationId: corrId,
		});
		const ev = await result;
		expect(ev.isError).toBe(true);
	});

	it("--yolo flag sets args.yolo=true", () => {
		const args = parseArgs(["node", "main.ts", "--yolo", "--no-tui"]);
		expect(args.yolo).toBe(true);
	});

	it("without --yolo, args.yolo is false", () => {
		const args = parseArgs(["node", "main.ts", "--no-tui"]);
		expect(args.yolo).toBe(false);
	});
});
