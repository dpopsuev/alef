import { describe, expect, it } from "vitest";
import { parseCauseFlags } from "../src/debug/cause-walk.js";

describe("parseCauseFlags", () => {
	it("parses positional span id", () => {
		expect(parseCauseFlags(["abc123"])).toEqual({ spanId: "abc123" });
	});

	it("parses --path and --type", () => {
		expect(parseCauseFlags(["--path", "/tmp/x.ts", "--type", "fs.write"])).toEqual({
			path: "/tmp/x.ts",
			type: "fs.write",
		});
	});

	it("parses span id with flags", () => {
		expect(parseCauseFlags(["deadbeef", "--path", "foo"])).toEqual({
			spanId: "deadbeef",
			path: "foo",
		});
	});
});
