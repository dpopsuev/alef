import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAdapterCommandRouter, defineAdapter, typedAction, typedStreamAction } from "../src/adapter/framework.js";

const ECHO_TOOL = {
	name: "echo.run",
	description: "Echo a value.",
	inputSchema: z.object({ value: z.string() }),
	outputSchema: z.object({ echoed: z.string() }),
	version: 1,
	permissions: ["echo:run"],
} as const;

const ADAPTER_OPTIONS = {
	description: "Echo test adapter.",
	directives: ["Use echo.run."],
};

describe("adapter capability commands", { tags: ["unit"] }, () => {
	it("materializes typed actions as directly returned commands", async () => {
		const adapter = defineAdapter(
			"echo",
			{
				command: {
					"echo.run": typedAction(ECHO_TOOL, ({ payload, toolCallId }) =>
						Promise.resolve({ echoed: `${payload.value}:${toolCallId}` }),
					),
				},
			},
			ADAPTER_OPTIONS,
		);
		const router = createAdapterCommandRouter([adapter]);

		await expect(
			router.executeByName("echo.run", 1, { value: "hello" }, {
				permissions: ["echo:run"],
				toolCallId: "call-1",
			}),
		).resolves.toEqual({ echoed: "hello:call-1" });
	});

	it("streams progress directly without command/result events", async () => {
		const progress = vi.fn();
		const adapter = defineAdapter(
			"echo",
			{
				command: {
					"echo.run": typedStreamAction(ECHO_TOOL, async function* () {
						yield { echoed: "first" };
						yield { echoed: "final" };
					}),
				},
			},
			ADAPTER_OPTIONS,
		);
		const router = createAdapterCommandRouter([adapter]);

		await expect(
			router.executeByName("echo.run", 1, { value: "hello" }, {
				permissions: ["echo:run"],
				onProgress: progress,
			}),
		).resolves.toEqual({ echoed: "final" });
		expect(progress).toHaveBeenCalledExactlyOnceWith({ echoed: "first" });
	});

	it("rejects duplicate command owners during materialization", () => {
		const makeAdapter = (name: string) =>
			defineAdapter(
				name,
				{ command: { "echo.run": typedAction(ECHO_TOOL, ({ payload }) => Promise.resolve({ echoed: payload.value })) } },
				ADAPTER_OPTIONS,
			);

		expect(() => createAdapterCommandRouter([makeAdapter("first"), makeAdapter("second")])).toThrow(
			/already owned by first/,
		);
	});
});
