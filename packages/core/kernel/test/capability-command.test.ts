import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CapabilityCommandError, CommandRouter, defineCommand } from "../src/capabilities.js";

const Echo = defineCommand({
	name: "test.echo",
	version: 1,
	input: z.object({ value: z.string() }),
	output: z.object({ echoed: z.string() }),
	permissions: ["test:echo"],
});

describe("CommandRouter", { tags: ["unit"] }, () => {
	it("returns a validated result from the command's sole owner", async () => {
		const router = new CommandRouter();
		router.register("echo-adapter", Echo, ({ input }) => Promise.resolve({ echoed: input.value }));

		await expect(router.execute(Echo, { value: "hello" }, { permissions: ["test:echo"] })).resolves.toEqual({
			echoed: "hello",
		});
		expect(router.ownerOf(Echo)).toBe("echo-adapter");
	});

	it("rejects duplicate ownership for the same name and version", () => {
		const router = new CommandRouter();
		router.register("first", Echo, ({ input }) => Promise.resolve({ echoed: input.value }));

		expect(() =>
			router.register("second", Echo, ({ input }) => Promise.resolve({ echoed: input.value })),
		).toThrow(/already owned by first/);
	});

	it("validates both input and output", async () => {
		const router = new CommandRouter();
		router.register("echo-adapter", Echo, () => Promise.resolve({ echoed: 42 } as never));

		await expect(
			router.execute(Echo, { value: 1 } as never, { permissions: ["test:echo"] }),
		).rejects.toMatchObject({ code: "invalid-input" });
		await expect(
			router.execute(Echo, { value: "hello" }, { permissions: ["test:echo"] }),
		).rejects.toMatchObject({ code: "invalid-output" });
	});

	it("fails closed when required permissions are absent", async () => {
		const router = new CommandRouter();
		router.register("echo-adapter", Echo, ({ input }) => Promise.resolve({ echoed: input.value }));

		await expect(router.execute(Echo, { value: "hello" })).rejects.toMatchObject({
			code: "permission-denied",
		});
	});

	it("propagates cancellation and deadlines to the owner", async () => {
		const router = new CommandRouter();
		let receivedSignal: AbortSignal | undefined;
		router.register("echo-adapter", Echo, ({ signal }) => {
			receivedSignal = signal;
			return new Promise((_, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		const controller = new AbortController();
		const execution = router.execute(Echo, { value: "hello" }, {
			permissions: ["test:echo"],
			signal: controller.signal,
		});
		controller.abort(new Error("stop"));

		await expect(execution).rejects.toMatchObject({ code: "cancelled" });
		expect(receivedSignal?.aborted).toBe(true);
		await expect(
			router.execute(Echo, { value: "late" }, { permissions: ["test:echo"], deadline: Date.now() - 1 }),
		).rejects.toMatchObject({ code: "deadline-exceeded" });
	});

	it("reports missing command versions as typed failures", async () => {
		const router = new CommandRouter();
		const VersionTwo = defineCommand({ ...Echo, version: 2 });
		router.register("echo-adapter", Echo, ({ input }) => Promise.resolve({ echoed: input.value }));

		await expect(
			router.execute(VersionTwo, { value: "hello" }, { permissions: ["test:echo"] }),
		).rejects.toBeInstanceOf(CapabilityCommandError);
		await expect(
			router.execute(VersionTwo, { value: "hello" }, { permissions: ["test:echo"] }),
		).rejects.toMatchObject({ code: "not-found" });
	});
});
