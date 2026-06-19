import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoardOrgan } from "../src/organ.js";

organComplianceSuite(() => createBoardOrgan({ sessionDir: mkdtempSync(join(tmpdir(), "alef-board-compliance-")) }));

describe("organ-board", { tags: ["unit"] }, () => {
	let sessionDir: string;

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "alef-board-test-"));
	});

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true });
	});

	it("creates an organ with board tools", () => {
		const organ = createBoardOrgan({ sessionDir });
		expect(organ.name).toBe("board");
		expect(organ.tools.map((t) => t.name)).toEqual(["board.post", "board.read", "board.list"]);
	});

	it("declares file sources", () => {
		const organ = createBoardOrgan({ sessionDir });
		expect(organ.sources).toEqual([{ name: "board-files", kind: "file" }]);
	});

	it("has context.assemble contribution", () => {
		const organ = createBoardOrgan({ sessionDir });
		expect(organ.contributions?.["context.assemble"]).toBeDefined();
	});
});
