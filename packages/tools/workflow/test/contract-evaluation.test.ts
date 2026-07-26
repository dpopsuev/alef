import { createAdapterCommandRouter } from "@dpopsuev/alef-kernel/adapter";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createContractTool } from "../src/adapter.js";
import { defineContract } from "../src/contract.js";

const contract = defineContract("Approve the value.", z.object({ value: z.string() }), "human");

describe("contract evaluation", { tags: ["unit"] }, () => {
	it("fails closed when no evaluator is configured", async () => {
		const onSubmit = vi.fn();
		const adapter = createContractTool(contract, onSubmit);
		const router = createAdapterCommandRouter([adapter]);

		await expect(router.executeByName("contract.submit", 1, { data: { value: "x" } })).resolves.toMatchObject({
			success: false,
			errors: expect.stringContaining("no evaluator is configured"),
		});
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("submits only after a direct evaluator approval", async () => {
		const onSubmit = vi.fn();
		const adapter = createContractTool(contract, onSubmit, async ({ output }) => ({ approved: output.value === "ok" }));
		const router = createAdapterCommandRouter([adapter]);

		await expect(router.executeByName("contract.submit", 1, { data: { value: "no" } })).resolves.toMatchObject({
			success: false,
		});
		await expect(router.executeByName("contract.submit", 1, { data: { value: "ok" } })).resolves.toMatchObject({
			success: true,
		});
		expect(onSubmit).toHaveBeenCalledOnce();
	});
});
