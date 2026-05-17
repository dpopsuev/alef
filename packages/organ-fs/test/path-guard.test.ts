import { describe, expect, it } from "vitest";
import { assertWithinRoot, guardedResolve } from "../src/path-guard.js";

describe("assertWithinRoot", () => {
	it("allows paths within root", () => {
		expect(() => assertWithinRoot("/workspace/src/foo.ts", "/workspace")).not.toThrow();
	});

	it("allows root itself", () => {
		expect(() => assertWithinRoot("/workspace", "/workspace")).not.toThrow();
	});

	it("rejects paths outside root", () => {
		expect(() => assertWithinRoot("/etc/passwd", "/workspace")).toThrow(/outside the workspace root/);
	});

	it("rejects traversal via ..", () => {
		// Node's resolve normalises these before comparison
		expect(() => assertWithinRoot("/workspace/../etc/passwd", "/workspace")).toThrow();
	});

	it("rejects sibling directories", () => {
		expect(() => assertWithinRoot("/workspace2/file.ts", "/workspace")).toThrow();
	});
});

describe("guardedResolve", () => {
	it("resolves relative path within root", () => {
		const abs = guardedResolve("src/foo.ts", { root: "/workspace" });
		expect(abs).toBe("/workspace/src/foo.ts");
	});

	it("resolves absolute path within root", () => {
		const abs = guardedResolve("/workspace/src/foo.ts", { root: "/workspace" });
		expect(abs).toBe("/workspace/src/foo.ts");
	});

	it("rejects absolute path outside root by default", () => {
		expect(() => guardedResolve("/etc/passwd", { root: "/workspace" })).toThrow(/outside the workspace root/);
	});

	it("allows absolute path outside root when allowAbsolutePaths=true", () => {
		expect(() => guardedResolve("/etc/passwd", { root: "/workspace", allowAbsolutePaths: true })).not.toThrow();
	});

	it("rejects traversal via ../", () => {
		expect(() => guardedResolve("../../etc/passwd", { root: "/workspace" })).toThrow();
	});
});
