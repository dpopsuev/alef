import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { describe, expect, it } from "vitest";
import { createSecurityPolicyOrgan } from "../src/organ.js";

organComplianceSuite(() => createSecurityPolicyOrgan());

describe("SecurityPolicyOrgan", { tags: ["unit"] }, () => {
	it("has name security-policy by default", () => {
		const organ = createSecurityPolicyOrgan();
		expect(organ.name).toBe("security-policy");
		expect(organ.tools).toHaveLength(0);
		expect(organ.subscriptions.motor).toContain("validate.required");
	});

	it("accepts custom name", () => {
		const organ = createSecurityPolicyOrgan({ name: "custom-policy" });
		expect(organ.name).toBe("custom-policy");
	});
});
