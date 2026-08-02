import { createAdapterCommandRouter, toolInputToJsonSchema } from "@dpopsuev/alef-kernel/adapter";
import { VehicleError, type VehicleClient, type VehicleInvocationOptions, type VehicleManifest } from "@danypops/vehicle-core";
import { describe, expect, it, vi } from "vitest";
import { createVehicleAdapter } from "../src/index.js";

const manifest: VehicleManifest = {
	name: "tasks",
	version: "1.2.3",
	description: "Task lifecycle",
	guidance: ["Use tasks.create for concrete work."],
	operations: [
		{
			name: "tasks.create",
			version: 1,
			description: "Create a task",
			inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
			outputSchema: { type: "object" },
			permissions: ["tasks:write"],
			effect: "local-write",
			idempotency: { mode: "safe" },
			streaming: true,
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
		{
			name: "tasks.secret",
			version: 1,
			description: "Unavailable operation",
			inputSchema: { type: "object" },
			outputSchema: { type: "object" },
			permissions: [],
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
			available: false,
		},
	],
};

describe("createVehicleAdapter", () => {
	it("projects available granted operations and preserves invocation context", async () => {
		let invocationOptions: VehicleInvocationOptions | undefined;
		const close = vi.fn(async () => {});
		const invoke = vi.fn(async (_name, _version, _input, options?: VehicleInvocationOptions) => {
			invocationOptions = options;
			options?.onProgress?.({ content: "working" });
			return { taskId: "task-1" };
		});
		const client: VehicleClient = {
			manifest: async () => manifest,
			async invoke<Output>(
				_name: string,
				_version: number,
				_input: unknown,
				options?: VehicleInvocationOptions,
			) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The fake returns the output this test requests.
				return (await invoke(_name, _version, _input, options)) as Output;
			},
			close,
		};
		const adapter = await createVehicleAdapter({ client, permissions: ["tasks:write"], maxOperations: 10 });
		const router = createAdapterCommandRouter([adapter]);
		const signal = new AbortController().signal;
		const progress = vi.fn();
		const deadline = Date.now() + 5_000;

		await expect(
			router.executeByName("tasks.create", 1, { title: "Ship" }, {
				signal,
				deadline,
				permissions: ["tasks:write"],
				correlationId: "correlation-1",
				toolCallId: "call-1",
				onProgress: progress,
			}),
		).resolves.toMatchObject({ output: { taskId: "task-1" } });
		expect(adapter.tools.map((tool) => tool.name)).toEqual(["tasks.create"]);
		expect(toolInputToJsonSchema(adapter.tools[0]!.inputSchema)).toEqual(manifest.operations[0]!.inputSchema);
		expect(toolInputToJsonSchema(adapter.tools[0]!.outputSchema!)).toEqual(manifest.operations[0]!.outputSchema);
		expect(adapter.tools[0]).toMatchObject({
			permissions: ["tasks:write"],
			effect: "external",
			streaming: true,
			version: 1,
		});
		expect(invoke).toHaveBeenCalledWith("tasks.create", 1, { title: "Ship" }, expect.any(Object));
		expect(invocationOptions).toMatchObject({
			signal,
			deadline,
			permissions: ["tasks:write"],
			correlationId: "correlation-1",
			operationId: "call-1",
		});
		expect(progress).toHaveBeenCalledWith({ content: "working" });
		const startedAt = Date.now();
		await router.executeByName("tasks.create", 1, { title: "Default deadline" }, { permissions: ["tasks:write"] });
		expect(invocationOptions?.deadline).toBeGreaterThanOrEqual(startedAt + 1_000);
		expect(invocationOptions?.deadline).toBeLessThanOrEqual(Date.now() + 1_000);
		await adapter.close?.();
		expect(close).toHaveBeenCalledOnce();
	});

	it("hides operations when the Workspace grant is insufficient", async () => {
		const client: VehicleClient = {
			manifest: async () => manifest,
			async invoke<Output>() {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The hidden operation is never invoked.
				return {} as Output;
			},
			close: async () => {},
		};
		const adapter = await createVehicleAdapter({ client, permissions: [], maxOperations: 10 });
		expect(adapter.tools).toEqual([]);
	});

	it("preserves structured Vehicle failures through Alef command errors", async () => {
		const failure = new VehicleError("capacity-exhausted", "Capacity exhausted", {
			category: "capacity",
			retryable: true,
			retryAfterMs: 250,
		});
		const client: VehicleClient = {
			manifest: async () => manifest,
			invoke: async () => {
				throw failure;
			},
			close: async () => {},
		};
		const adapter = await createVehicleAdapter({ client, permissions: ["tasks:write"], maxOperations: 10 });
		const router = createAdapterCommandRouter([adapter]);
		try {
			await router.executeByName("tasks.create", 1, { title: "Ship" }, { permissions: ["tasks:write"] });
			expect.unreachable("Vehicle failure should reject the command");
		} catch (error) {
			expect(error).toMatchObject({ code: "handler-failed", cause: failure, details: failure.toFailure() });
			expect(error).toHaveProperty("message", "Capacity exhausted");
		}
	});
});
