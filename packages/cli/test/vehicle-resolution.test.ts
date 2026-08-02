import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vehicleName } from "@dpopsuev/alef-blueprint/types";
import { createAdapterCommandRouter } from "@dpopsuev/alef-kernel/adapter";
import { describe, expect, it, vi } from "vitest";
import { loadAdapters } from "../src/boot/adapters.js";
import type { Args } from "../src/boot/args.js";
import { createVehicleResolver } from "../src/boot/vehicles.js";

const manifest = {
	name: "tasks",
	version: "1.0.0",
	description: "Task operations",
	guidance: [],
	operations: [
		{
			name: "tasks.list",
			version: 1,
			description: "List tasks",
			inputSchema: { type: "object" },
			outputSchema: { type: "object" },
			permissions: ["tasks:read"],
			effect: "read",
			idempotency: { mode: "safe" },
			streaming: false,
			longRunning: false,
			limits: {
				defaultTimeoutMs: 1_000,
				maxTimeoutMs: 5_000,
				maxRequestBytes: 4_096,
				maxResponseBytes: 8_192,
			},
			errors: [],
			available: true,
		},
	],
};

describe("createVehicleResolver", { tags: ["unit"] }, () => {
	it("connects a declared Workspace Vehicle through authenticated HTTP", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.endsWith("/vehicle/manifest")) {
				expect(init?.headers).toEqual({ authorization: "Bearer secret" });
				return Response.json(manifest);
			}
			expect(url).toBe("http://127.0.0.1:4242/vehicle/invoke");
			return new Response('event: result\ndata: {"output":{"tasks":[]}}\n\n', {
				headers: { "content-type": "text/event-stream" },
			});
		});
		const cwd = mkdtempSync(join(tmpdir(), "alef-vehicle-"));
		const blueprintPath = join(cwd, "vehicle.yaml");
		writeFileSync(
			blueprintPath,
			"name: vehicle-agent\nvehicles:\n  - name: tasks\n    maxOperations: 10\n    permissions: [tasks:read]\n",
		);
		const previousToken = process.env.TASKS_TOKEN;
		process.env.TASKS_TOKEN = "secret";
		try {
			const args = { cwd, blueprint: blueprintPath, print: true, json: false, noTui: true, yolo: false } as Args;
			const config = {
				vehicles: { tasks: { base_url: "http://127.0.0.1:4242", token_env: "TASKS_TOKEN" } },
			};
			const log = { info: vi.fn(), child: () => log } as never;
			const result = await loadAdapters(args, config, log);
			const router = createAdapterCommandRouter(result.adapters);
			await expect(
				router.executeByName("tasks.list", 1, {}, { permissions: ["tasks:read"] }),
			).resolves.toMatchObject({ output: { tasks: [] } });
			await Promise.all(result.adapters.map((adapter) => adapter.close?.()));
		} finally {
			fetchMock.mockRestore();
			if (previousToken === undefined) delete process.env.TASKS_TOKEN;
			else process.env.TASKS_TOKEN = previousToken;
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fails closed when the credential is unavailable", async () => {
		const resolveVehicle = createVehicleResolver(
			{ vehicles: { tasks: { base_url: "http://127.0.0.1:4242", token_env: "TASKS_TOKEN" } } },
			{},
		);
		await expect(
			resolveVehicle({ name: vehicleName("tasks"), maxOperations: 10, permissions: [] }, { cwd: "/tmp" }),
		).rejects.toThrow("TASKS_TOKEN");
	});

	it("rejects plaintext remote connections", async () => {
		const resolveVehicle = createVehicleResolver(
			{ vehicles: { tasks: { base_url: "http://vehicle.example", token_env: "TASKS_TOKEN" } } },
			{ TASKS_TOKEN: "secret" },
		);
		await expect(
			resolveVehicle({ name: vehicleName("tasks"), maxOperations: 10, permissions: [] }, { cwd: "/tmp" }),
		).rejects.toThrow("requires HTTPS");
	});
});
