import { describe, expect, it } from "vitest";
import { getAlfUserAgent } from "../src/utils/alf-user-agent.js";

describe("getAlfUserAgent", () => {
	it("includes runtime and arch", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getAlfUserAgent("1.2.3");

		expect(userAgent).toBe(`alf/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^alf\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
