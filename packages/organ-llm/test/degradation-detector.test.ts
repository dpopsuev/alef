import { describe, expect, it } from "vitest";
import { DegradationDetector } from "../src/degradation-detector.js";

describe("DegradationDetector", { tags: ["unit"] }, () => {
	it("no warning on first two reads", () => {
		const d = new DegradationDetector();
		expect(d.onToolEnd("fs.read", { path: "foo.ts" })).toBeUndefined();
		expect(d.onToolEnd("fs.read", { path: "foo.ts" })).toBeUndefined();
	});

	it("warns on third read of same file", () => {
		const d = new DegradationDetector();
		d.onToolEnd("fs.read", { path: "foo.ts" });
		d.onToolEnd("fs.read", { path: "foo.ts" });
		const warn = d.onToolEnd("fs.read", { path: "foo.ts" });
		expect(warn).toContain("foo.ts");
		expect(warn).toContain("3 times");
	});

	it("different files don't trigger", () => {
		const d = new DegradationDetector();
		d.onToolEnd("fs.read", { path: "a.ts" });
		d.onToolEnd("fs.read", { path: "b.ts" });
		d.onToolEnd("fs.read", { path: "c.ts" });
		expect(d.onToolEnd("fs.read", { path: "d.ts" })).toBeUndefined();
	});

	it("warns on repeated identical tool call", () => {
		const d = new DegradationDetector();
		d.onToolEnd("shell.exec", { command: "ls" });
		d.onToolEnd("shell.exec", { command: "ls" });
		const warn = d.onToolEnd("shell.exec", { command: "ls" });
		expect(warn).toContain("shell.exec");
		expect(warn).toContain("3 times");
	});

	it("tracks stats", () => {
		const d = new DegradationDetector();
		d.onTurnStart();
		d.onTurnStart();
		d.onToolEnd("fs.read", { path: "a.ts" });
		const stats = d.stats();
		expect(stats.turns).toBe(2);
		expect(stats.fileReads).toBe(1);
		expect(stats.repeatedCalls).toBe(0);
	});
});
