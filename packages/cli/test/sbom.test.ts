/**
 * SBOM generation and loading tests.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadSbom, type Sbom } from "../src/boot/sbom.js";

const ROOT = join(import.meta.dirname, "../../..");
const SBOM_PATH = join(ROOT, "sbom.test.json");

describe("SBOM generation", { tags: ["unit"] }, () => {
	afterAll(() => {
		try {
			unlinkSync(SBOM_PATH);
		} catch {
			/* cleanup */
		}
	});

	it("generates a valid SBOM with all component groups", () => {
		execSync(`npx tsx scripts/generate-sbom.ts --output ${SBOM_PATH}`, {
			cwd: ROOT,
			encoding: "utf-8",
			stdio: "pipe",
		});

		expect(existsSync(SBOM_PATH)).toBe(true);
		const sbom = JSON.parse(readFileSync(SBOM_PATH, "utf-8")) as Sbom;

		expect(sbom.version).toBe(1);
		expect(sbom.generatedAt).toBeTruthy();
		expect(sbom.gitHash).toBeTruthy();
		expect(sbom.components.length).toBeGreaterThan(0);
	});

	it("includes bootstrapper, tui, supervisor, and adapter components", () => {
		const sbom = JSON.parse(readFileSync(SBOM_PATH, "utf-8")) as Sbom;
		const names = sbom.components.map((c) => c.name);

		expect(names).toContain("bootstrapper");
		expect(names).toContain("tui");
		expect(names).toContain("supervisor");
		expect(names.some((n) => n.startsWith("adapter:"))).toBe(true);
	});

	it("each component has a 16-char hex hash", () => {
		const sbom = JSON.parse(readFileSync(SBOM_PATH, "utf-8")) as Sbom;
		for (const c of sbom.components) {
			expect(c.hash, `${c.name} hash`).toMatch(/^[0-9a-f]{16}$/);
		}
	});

	it("maps restart scopes correctly", () => {
		const sbom = JSON.parse(readFileSync(SBOM_PATH, "utf-8")) as Sbom;
		const byName = new Map(sbom.components.map((c) => [c.name, c]));

		expect(byName.get("bootstrapper")?.scope).toBe("exit");
		expect(byName.get("tui")?.scope).toBe("tui");
		expect(byName.get("supervisor")?.scope).toBe("supervisor");
		expect(byName.get("core:kernel")?.scope).toBe("exit");

		const adapters = sbom.components.filter((c) => c.name.startsWith("adapter:"));
		for (const a of adapters) {
			expect(a.scope, `${a.name} scope`).toBe("adapter");
		}
	});

	it("hashes are deterministic (same content produces same hash)", () => {
		const secondPath = SBOM_PATH.replace(".json", ".second.json");
		try {
			execSync(`npx tsx scripts/generate-sbom.ts --output ${secondPath}`, {
				cwd: ROOT,
				encoding: "utf-8",
				stdio: "pipe",
			});
			const first = JSON.parse(readFileSync(SBOM_PATH, "utf-8")) as Sbom;
			const second = JSON.parse(readFileSync(secondPath, "utf-8")) as Sbom;

			for (const fc of first.components) {
				const sc = second.components.find((c) => c.name === fc.name);
				expect(sc, `${fc.name} missing in second run`).toBeDefined();
				expect(sc!.hash, `${fc.name} hash changed between runs`).toBe(fc.hash);
			}
		} finally {
			try {
				unlinkSync(secondPath);
			} catch {
				/* cleanup */
			}
		}
	});
});

describe("loadSbom", { tags: ["unit"] }, () => {
	it("loads a valid SBOM from disk", () => {
		const sbom = loadSbom(ROOT);
		if (!existsSync(join(ROOT, "sbom.json"))) {
			expect(sbom).toBeNull();
			return;
		}
		expect(sbom).not.toBeNull();
		expect(sbom!.version).toBe(1);
	});

	it("returns null for missing SBOM", () => {
		const sbom = loadSbom("/nonexistent/path");
		expect(sbom).toBeNull();
	});
});
