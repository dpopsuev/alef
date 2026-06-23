import { NerveFixture, organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, describe, expect, it } from "vitest";
import { createMetaOrgan } from "../src/adapter.js";

organComplianceSuite(() => createMetaOrgan({ dialogEventType: "llm.input" }));

describe("alef.rebuild", { tags: ["unit"] }, () => {
	const f = new NerveFixture();
	afterEach(() => f.dispose());

	it("returns ok:false when onRebuildRequest is not provided", async () => {
		f.mount(createMetaOrgan({ dialogEventType: "llm.input" }));

		const result = await f.call("alef.rebuild", {});
		expect(result.isError).toBe(false);
		expect((result.payload as { ok?: boolean }).ok).toBe(false);
		expect((result.payload as { reason?: string }).reason).toMatch(/supervisor not running/);
	});

	it("returns ok:true and calls onRebuildRequest when provided", async () => {
		let called = false;
		f.mount(
			createMetaOrgan({
				dialogEventType: "llm.input",
				onRebuildRequest: () => {
					called = true;
				},
			}),
		);

		const result = await f.call("alef.rebuild", {});
		expect(result.isError).toBe(false);
		expect((result.payload as { ok?: boolean }).ok).toBe(true);
		expect(called).toBe(true);
	});
});
