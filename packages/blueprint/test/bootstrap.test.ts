/**
 * Bootstrap blueprint tests — ensureBootstrapBlueprints lifecycle.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentDefinition } from "../src/blueprints.js";
import { ensureBootstrapBlueprints } from "../src/bootstrap.js";

const tempDirs: string[] = [];

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "alef-bs-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("ensureBootstrapBlueprints", () => {
	it("creates target directories and copies all three blueprints", () => {
		const agentDir = tmpDir();
		ensureBootstrapBlueprints(agentDir);

		const targetDir = join(agentDir, "blueprints", "bootstrap");
		expect(existsSync(join(targetDir, "gensec.yaml"))).toBe(true);
		expect(existsSync(join(targetDir, "2sec.yaml"))).toBe(true);
		expect(existsSync(join(targetDir, "primordial.yaml"))).toBe(true);
	});

	it("returns an entry set with all three ids", () => {
		const result = ensureBootstrapBlueprints(tmpDir());
		expect(Object.keys(result.entries).sort()).toEqual(["2sec", "gensec", "primordial"]);
	});

	it("entries have correct id, label, sourcePath and targetPath", () => {
		const agentDir = tmpDir();
		const result = ensureBootstrapBlueprints(agentDir);

		const gensec = result.entries.gensec;
		expect(gensec.id).toBe("gensec");
		expect(gensec.label).toBe("GenSec");
		expect(existsSync(gensec.sourcePath)).toBe(true);
		expect(gensec.targetPath).toContain(agentDir);
		expect(existsSync(gensec.targetPath)).toBe(true);
	});

	it("is idempotent — second call succeeds without error", () => {
		const agentDir = tmpDir();
		ensureBootstrapBlueprints(agentDir);
		expect(() => ensureBootstrapBlueprints(agentDir)).not.toThrow();
	});

	it("does not overwrite an existing target file with custom content", () => {
		const agentDir = tmpDir();
		// Run once to create dirs and files.
		ensureBootstrapBlueprints(agentDir);

		// Overwrite the target with custom content.
		const targetDir = join(agentDir, "blueprints", "bootstrap");
		const targetPath = join(targetDir, "gensec.yaml");
		writeFileSync(targetPath, "name: custom-gensec\n");

		// Run again — should NOT overwrite.
		ensureBootstrapBlueprints(agentDir);
		expect(readFileSync(targetPath, "utf-8")).toBe("name: custom-gensec\n");
	});

	it("copied files are valid YAML loadable as agent definitions", () => {
		const agentDir = tmpDir();
		const result = ensureBootstrapBlueprints(agentDir);

		for (const [, entry] of Object.entries(result.entries)) {
			const def = loadAgentDefinition(entry.targetPath);
			expect(typeof def.name).toBe("string");
			expect(def.name.length).toBeGreaterThan(0);
		}
	});
});
