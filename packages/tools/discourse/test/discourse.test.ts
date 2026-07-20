import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { describe, expect, it } from "vitest";
import { createDiscourseAdapter } from "../src/adapter.js";
import { CapabilityDiscourseBackend } from "../src/capability-backend.js";

adapterComplianceSuite(() => createDiscourseAdapter({}));

describe("discourse adapter structure", () => {
	it("creates the established tool surface over the shared capability", () => {
		const adapter = createDiscourseAdapter({ backend: new CapabilityDiscourseBackend() });
		expect(adapter.name).toBe("discourse");
		expect(adapter.tools.map((tool) => tool.name)).toEqual(["discourse.post", "discourse.read", "discourse.list"]);
	});

	it("declares context delivery and coordination directives", () => {
		const adapter = createDiscourseAdapter({});
		expect(adapter.contributions?.["context.assemble"]).toBeDefined();
		expect(adapter.directives?.length).toBeGreaterThan(0);
	});

	it("rejects a second direct-mutation implementation", () => {
		const legacy = {
			append: async () => {
				throw new Error("unused");
			},
			readThread: async () => [],
			listTopics: async () => [],
			listThreads: async () => [],
			threadInfo: async () => ({ name: "", posts: 0, participants: [], lastActivity: 0 }),
			topicSummaries: async () => [],
			readNewPosts: async () => [],
		};
		expect(() => createDiscourseAdapter({ backend: legacy })).toThrow("capability-backed");
	});
});
