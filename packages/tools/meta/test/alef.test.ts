import { adapterComplianceSuite, BusFixture } from "@dpopsuev/alef-testkit/adapter";
import { afterEach, describe, expect, it } from "vitest";
import { createMetaAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createMetaAdapter({ dialogEventType: "llm.input" }));

describe("alef.rebuild", { tags: ["unit"] }, () => {
	const f = new BusFixture();
	afterEach(() => f.dispose());

	it("returns ok:false when onRebuildRequest is not provided", async () => {
		f.mount(createMetaAdapter({ dialogEventType: "llm.input" }));

		const result = await f.call("alef.rebuild", {});
		expect(result.isError).toBe(false);
		expect((result.payload as { ok?: boolean }).ok).toBe(false);
		expect((result.payload as { reason?: string }).reason).toMatch(/supervisor not running/);
	});

	it("returns ok:true and calls onRebuildRequest when provided", async () => {
		let called = false;
		f.mount(
			createMetaAdapter({
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
