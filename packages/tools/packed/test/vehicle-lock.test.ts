import type { VehicleManifest } from "@danypops/vehicle-core";
import { describe, expect, it } from "vitest";
import { compileVehicleAgentToolsLock } from "../src/index.js";

const manifest: VehicleManifest = {
	name: "tasks",
	version: "1.2.3",
	description: "Task lifecycle",
	operations: [
		{
			name: "tasks.create",
			version: 1,
			description: "Create a task",
			inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
			outputSchema: { type: "object" },
			permissions: ["tasks:write"],
			effect: "local-write",
			idempotency: { mode: "keyed", retentionMs: 60_000 },
			streaming: false,
			longRunning: false,
			limits: {
				defaultTimeoutMs: 1_000,
				maxTimeoutMs: 5_000,
				maxRequestBytes: 4_096,
				maxResponseBytes: 8_192,
			},
			errors: [],
			available: false,
			unavailableReason: "credentials missing",
		},
	],
	events: [],
};

describe("compileVehicleAgentToolsLock", () => {
	it("projects static Vehicle operation metadata into the host-neutral lock", () => {
		const lock = compileVehicleAgentToolsLock({
			source: "vehicle:http://127.0.0.1:7777",
			integrity: "sha256-static-manifest",
			manifestPath: "/manifest",
			manifest,
			maxOperations: 10,
		});

		expect(lock.packages).toEqual([
			expect.objectContaining({
				id: "tasks",
				kind: "vehicle",
				version: "1.2.3",
				resources: [{ kind: "vehicle-manifest", path: "/manifest" }],
				permissions: ["tasks:write"],
			}),
		]);
		expect(lock.tools).toEqual([
			expect.objectContaining({
				name: "tasks.create",
				owner: "tasks",
				permissions: ["tasks:write"],
				effects: ["effect:local-write", "idempotency:keyed"],
				limits: {
					defaultTimeoutMs: 1_000,
					maxTimeoutMs: 5_000,
					maxRequestBytes: 4_096,
					maxResponseBytes: 8_192,
				},
			}),
		]);
		expect(JSON.stringify(lock)).not.toContain("available");
		expect(Object.isFrozen(lock)).toBe(true);
	});

	it("refuses an unbounded manifest", () => {
		expect(() =>
			compileVehicleAgentToolsLock({
				source: "vehicle:http://127.0.0.1:7777",
				integrity: "sha256-static-manifest",
				manifestPath: "/manifest",
				manifest,
				maxOperations: 0,
			}),
		).toThrow("maxOperations must be a positive integer");
	});

	it("refuses a manifest larger than the declared bound", () => {
		expect(() =>
			compileVehicleAgentToolsLock({
				source: "vehicle:http://127.0.0.1:7777",
				integrity: "sha256-static-manifest",
				manifest: { ...manifest, operations: [...manifest.operations, manifest.operations[0]!] },
				manifestPath: "/manifest",
				maxOperations: 1,
			}),
		).toThrow("Vehicle manifest exceeds maxOperations (1)");
	});
});
