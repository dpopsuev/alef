import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AlefConfig } from "../src/config.js";
import { resolveWritableRoots } from "../src/load-organs.js";

describe("resolveWritableRoots", { tags: ["unit"] }, () => {
	afterEach(() => {
		delete process.env.ALEF_WRITABLE_ROOTS;
	});

	it("returns undefined when no security config (unrestricted)", () => {
		const cfg: AlefConfig = {};
		expect(resolveWritableRoots("/workspace", cfg)).toBeUndefined();
	});

	it("resolves cwd placeholder", () => {
		const cfg: AlefConfig = { security: { writable_roots: ["$" + "{cwd}"] } };
		const result = resolveWritableRoots("/workspace", cfg);
		expect(result).toEqual([resolve("/workspace")]);
	});

	it("resolves tmpdir placeholder", () => {
		const cfg: AlefConfig = { security: { writable_roots: ["$" + "{tmpdir}"] } };
		const result = resolveWritableRoots("/workspace", cfg);
		expect(result).toEqual([resolve(tmpdir())]);
	});

	it("resolves multiple roots with mixed placeholders", () => {
		const cfg: AlefConfig = { security: { writable_roots: ["$" + "{cwd}", "$" + "{tmpdir}", "/data"] } };
		const result = resolveWritableRoots("/workspace", cfg);
		expect(result).toEqual([resolve("/workspace"), resolve(tmpdir()), resolve("/data")]);
	});

	it("inherits from ALEF_WRITABLE_ROOTS env var when no config", () => {
		process.env.ALEF_WRITABLE_ROOTS = JSON.stringify(["/workspace", "/tmp"]);
		const cfg: AlefConfig = {};
		const result = resolveWritableRoots("/workspace", cfg);
		expect(result).toEqual([resolve("/workspace"), resolve("/tmp")]);
	});

	it("config takes precedence over env var", () => {
		process.env.ALEF_WRITABLE_ROOTS = JSON.stringify(["/inherited"]);
		const cfg: AlefConfig = { security: { writable_roots: ["$" + "{cwd}"] } };
		const result = resolveWritableRoots("/workspace", cfg);
		expect(result).toEqual([resolve("/workspace")]);
	});

	it("returns undefined for malformed env var", () => {
		process.env.ALEF_WRITABLE_ROOTS = "not-json";
		const cfg: AlefConfig = {};
		expect(resolveWritableRoots("/workspace", cfg)).toBeUndefined();
	});
});
