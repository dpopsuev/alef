import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { describe, expect, it } from "vitest";
import { createDiscourseAdapter } from "../src/index.js";

adapterComplianceSuite(() => createDiscourseAdapter({}));

describe("alef-discourse adapter structure", () => {
	it("registers the established forum tool surface", () => {
		const adapter = createDiscourseAdapter();
		expect(adapter.name).toBe("discourse");
		expect(adapter.tools.map((tool) => tool.name)).toEqual(["discourse.post", "discourse.read", "discourse.list"]);
	});

	it("declares sequenced context delivery and coordination directives", () => {
		const adapter = createDiscourseAdapter();
		expect(adapter.contributions?.["context.stage"]).toBeDefined();
		expect(adapter.directives?.length).toBeGreaterThan(0);
	});

	it("declares an in-memory, process-local source", () => {
		const adapter = createDiscourseAdapter();
		expect(adapter.sources).toEqual([{ name: "in-memory", kind: "process" }]);
	});
});
