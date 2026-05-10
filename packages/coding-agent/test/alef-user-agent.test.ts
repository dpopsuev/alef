import { describe, expect, it } from "vitest";
import { getAlefUserAgent } from "../src/utils/alef-user-agent.js";

describe("getAlefUserAgent", () => {
	it("includes runtime and arch", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getAlefUserAgent("1.2.3");

		expect(userAgent).toBe(`alef/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^alef\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
