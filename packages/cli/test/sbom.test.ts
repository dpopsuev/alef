/**
 * SBOM generation tests.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateSbom, SBOM } from "../src/boot/sbom.js";

const ROOT = join(import.meta.dirname, "../../..");

describe("generateSbom", { tags: ["unit"] }, () => {
	it("produces a valid SBOM with all component groups", () => {
		const sbom = generateSbom(ROOT);
		expect(sbom.version).toBe(1);
		expect(sbom.generatedAt).toBeTruthy();
		expect(sbom.gitHash).toBeTruthy();
		expect(sbom.components.length).toBeGreaterThan(0);
	});

	it("includes bootstrapper, tui, supervisor, and adapter components", () => {
		const sbom = generateSbom(ROOT);
		const names = sbom.components.map((c) => c.name);
		expect(names).toContain("bootstrapper");
		expect(names).toContain("tui");
		expect(names).toContain("supervisor");
		expect(names.some((n) => n.startsWith("adapter:"))).toBe(true);
	});

	it("each component has a 16-char hex hash", () => {
		const sbom = generateSbom(ROOT);
		for (const c of sbom.components) {
			expect(c.hash, `${c.name} hash`).toMatch(/^[0-9a-f]{16}$/);
		}
	});

	it("maps restart scopes correctly", () => {
		const sbom = generateSbom(ROOT);
		const byName = new Map(sbom.components.map((c) => [c.name, c]));
		expect(byName.get("bootstrapper")?.scope).toBe("exit");
		expect(byName.get("tui")?.scope).toBe("tui");
		expect(byName.get("supervisor")?.scope).toBe("supervisor");
		expect(byName.get("core:kernel")?.scope).toBe("exit");

		for (const a of sbom.components.filter((c) => c.name.startsWith("adapter:"))) {
			expect(a.scope, `${a.name} scope`).toBe("adapter");
		}
	});

	it("hashes are deterministic", () => {
		const first = generateSbom(ROOT);
		const second = generateSbom(ROOT);
		for (const fc of first.components) {
			const sc = second.components.find((c) => c.name === fc.name);
			expect(sc, `${fc.name} missing in second run`).toBeDefined();
			expect(sc!.hash, `${fc.name} hash changed between runs`).toBe(fc.hash);
		}
	});
});

describe("SBOM constant", { tags: ["unit"] }, () => {
	it("is pre-computed at import time", () => {
		expect(SBOM.version).toBe(1);
		expect(SBOM.components.length).toBeGreaterThan(0);
	});

	it("matches a fresh generateSbom call", () => {
		const fresh = generateSbom(ROOT);
		for (const c of SBOM.components) {
			const fc = fresh.components.find((f) => f.name === c.name);
			expect(fc, `${c.name} missing in fresh`).toBeDefined();
			expect(fc!.hash, `${c.name} hash drift`).toBe(c.hash);
		}
	});
});
