/**
 * Unit tests for wrapWithPermissions.
 */

import { wrapWithPermissions } from "@dpopsuev/alef-agent-blueprint";
import type { Organ } from "@dpopsuev/alef-kernel";
import { InProcessNerve } from "@dpopsuev/alef-kernel";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

declare module "@dpopsuev/alef-kernel" {
	interface MotorEventRegistry {
		"fs.read": { path: string; toolCallId: string };
		"fs.write": { path: string; content: string; toolCallId: string };
		"shell.exec": { command: string; toolCallId: string };
	}
	interface SenseEventRegistry {
		"fs.read": { content: string; toolCallId: string };
		"fs.write": { ok: boolean; toolCallId: string };
		"shell.exec": { output: string; toolCallId: string };
	}
}

function makePassthroughOrgan(name: string): Organ {
	return {
		name,
		tools: [],
		subscriptions: { motor: ["fs.read" as const, "fs.write" as const], sense: [] },
		sources: [],
		mount(nerve) {
			const off1 = nerve.motor.subscribe("fs.read", (e) => {
				nerve.sense.publish({
					type: "fs.read",
					payload: { content: "data", toolCallId: e.payload.toolCallId },
					correlationId: e.correlationId,
					isError: false,
				});
			});
			const off2 = nerve.motor.subscribe("fs.write", (e) => {
				nerve.sense.publish({
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

function waitSense(nerve: InProcessNerve, type: string, correlationId: string) {
	return new Promise<import("@dpopsuev/alef-kernel").SenseEvent>((resolve) => {
		const off = nerve.asNerve().sense.subscribe(type, (e) => {
			if (e.correlationId === correlationId) {
				off();
				resolve(e);
			}
		});
	});
}

describe("wrapWithPermissions", { tags: ["unit"] }, () => {
	it("['*'] bypasses gate — all tools pass through", async () => {
		const nerve = new InProcessNerve();
		const organ = wrapWithPermissions(makePassthroughOrgan("fs"), ["*"]);
		organ.mount(nerve.asNerve());

		const corrId = "corr-yolo";
		const result = waitSense(nerve, "fs.read", corrId);
		nerve
			.asNerve()
			.motor.publish({ type: "fs.read", payload: { path: "a.ts", toolCallId: "tc1" }, correlationId: corrId });
		const ev = await result;
		expect(ev.isError).toBe(false);
	});

	it("allowed tool passes through to organ handler", async () => {
		const nerve = new InProcessNerve();
		const organ = wrapWithPermissions(makePassthroughOrgan("fs"), ["fs.read"]);
		organ.mount(nerve.asNerve());

		const corrId = "corr-allow";
		const result = waitSense(nerve, "fs.read", corrId);
		nerve
			.asNerve()
			.motor.publish({ type: "fs.read", payload: { path: "b.ts", toolCallId: "tc2" }, correlationId: corrId });
		const ev = await result;
		expect(ev.isError).toBe(false);
		expect((ev.payload as { content?: string }).content).toBe("data");
	});

	it("denied tool publishes isError sense event with permission message", async () => {
		const nerve = new InProcessNerve();
		const organ = wrapWithPermissions(makePassthroughOrgan("fs"), ["fs.read"]);
		organ.mount(nerve.asNerve());

		const corrId = "corr-deny";
		const result = waitSense(nerve, "fs.write", corrId);
		nerve.asNerve().motor.publish({
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
		const nerve = new InProcessNerve();
		const organ = wrapWithPermissions(makePassthroughOrgan("fs"), []);
		organ.mount(nerve.asNerve());

		const corrId = "corr-empty";
		const result = waitSense(nerve, "fs.read", corrId);
		nerve
			.asNerve()
			.motor.publish({ type: "fs.read", payload: { path: "a.ts", toolCallId: "tc4" }, correlationId: corrId });
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
