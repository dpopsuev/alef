import { describe, expect, it } from "vitest";
import { assertWithinRoots, guardedResolve } from "../src/path-guard.js";

describe("assertWithinRoots", { tags: ["unit"] }, () => {
	it("allows paths within a single root", () => {
		expect(() => assertWithinRoots("/workspace/src/foo.ts", ["/workspace"])).not.toThrow();
	});

	it("allows root itself", () => {
		expect(() => assertWithinRoots("/workspace", ["/workspace"])).not.toThrow();
	});

	it("rejects paths outside all roots", () => {
		expect(() => assertWithinRoots("/etc/passwd", ["/workspace"])).toThrow(/outside the allowed roots/);
	});

	it("rejects traversal via ..", () => {
		expect(() => assertWithinRoots("/workspace/../etc/passwd", ["/workspace"])).toThrow();
	});

	it("rejects sibling directories", () => {
		expect(() => assertWithinRoots("/workspace2/file.ts", ["/workspace"])).toThrow();
	});

	it("allows paths within any of multiple roots", () => {
		expect(() => assertWithinRoots("/tmp/work/out.txt", ["/workspace", "/tmp"])).not.toThrow();
		expect(() => assertWithinRoots("/workspace/src/foo.ts", ["/workspace", "/tmp"])).not.toThrow();
	});

	it("rejects paths outside all multiple roots", () => {
		expect(() => assertWithinRoots("/etc/passwd", ["/workspace", "/tmp"])).toThrow();
	});
});

describe("guardedResolve", { tags: ["unit"] }, () => {
	it("resolves relative path within root", () => {
		const abs = guardedResolve("src/foo.ts", { root: "/workspace" });
		expect(abs).toBe("/workspace/src/foo.ts");
	});

	it("resolves absolute path within root", () => {
		const abs = guardedResolve("/workspace/src/foo.ts", { root: "/workspace" });
		expect(abs).toBe("/workspace/src/foo.ts");
	});

	it("rejects absolute path outside root when no writableRoots", () => {
		expect(() => guardedResolve("/etc/passwd", { root: "/workspace" })).toThrow(/outside the allowed roots/);
	});

	it("allows path in writableRoots even if outside root", () => {
		const abs = guardedResolve("/tmp/alef/output.txt", { root: "/workspace", writableRoots: ["/workspace", "/tmp"] });
		expect(abs).toBe("/tmp/alef/output.txt");
	});

	it("defaults to [root] when writableRoots is omitted", () => {
		expect(() => guardedResolve("/tmp/file.txt", { root: "/workspace" })).toThrow();
	});

	it("rejects traversal via ../", () => {
		expect(() => guardedResolve("../../etc/passwd", { root: "/workspace" })).toThrow();
	});
});
