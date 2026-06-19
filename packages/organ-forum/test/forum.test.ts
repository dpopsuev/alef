import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createForumOrgan } from "../src/organ.js";

organComplianceSuite(() => createForumOrgan({ sessionDir: mkdtempSync(join(tmpdir(), "alef-forum-compliance-")) }));

describe("organ-forum", { tags: ["unit"] }, () => {
	let sessionDir: string;

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "alef-forum-test-"));
	});

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true });
	});

	it("creates an organ with forum tools", () => {
		const organ = createForumOrgan({ sessionDir });
		expect(organ.name).toBe("forum");
		expect(organ.tools.map((t) => t.name)).toEqual(["forum.post", "forum.read", "forum.list"]);
	});

	it("declares file sources", () => {
		const organ = createForumOrgan({ sessionDir });
		expect(organ.sources).toEqual([{ name: "forum-files", kind: "file" }]);
	});

	it("has context.assemble contribution", () => {
		const organ = createForumOrgan({ sessionDir });
		expect(organ.contributions?.["context.assemble"]).toBeDefined();
	});
});
