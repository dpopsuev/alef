import { NerveFixture, organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, describe, expect, it } from "vitest";
import { createAlefApiOrgan } from "../src/organ.js";

organComplianceSuite(() => createAlefApiOrgan());

// ---------------------------------------------------------------------------
// alef.rebuild — blue-green trigger
// ---------------------------------------------------------------------------

describe("alef.rebuild", () => {
	const f = new NerveFixture();
	afterEach(() => f.dispose());

	it("returns ok:false when supervisor is not running (alefRequestRebuild absent)", async () => {
		delete (globalThis as Record<string, unknown>).alefRequestRebuild;
		f.mount(createAlefApiOrgan());

		const result = await f.call("alef.rebuild", {});
		expect(result.isError).toBe(false);
		expect((result.payload as { ok?: boolean }).ok).toBe(false);
		expect((result.payload as { reason?: string }).reason).toMatch(/supervisor not running/);
	});

	it("returns ok:true and calls alefRequestRebuild when supervisor is running", async () => {
		let called = false;
		(globalThis as Record<string, unknown>).alefRequestRebuild = () => {
			called = true;
		};
		f.mount(createAlefApiOrgan());

		const result = await f.call("alef.rebuild", {});
		expect(result.isError).toBe(false);
		expect((result.payload as { ok?: boolean }).ok).toBe(true);
		expect(called).toBe(true);

		delete (globalThis as Record<string, unknown>).alefRequestRebuild;
	});
});
