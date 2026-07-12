import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectEnvironment } from "../src/environment.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "alef-env-"));
	dirs.push(dir);
	return dir;
}

describe("detectEnvironment", { tags: ["unit"] }, () => {
	it("reports production when tsconfig is missing", () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));

		const env = detectEnvironment(cwd);

		expect(env.mode).toBe("production");
		expect(env.canHotReload).toBe(false);
		expect(env.buildCommand).toBeNull();
	});

	it("sets canHotReload false when development but no build script", () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "tsconfig.json"), "{}");
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
		mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(cwd, "node_modules", ".bin", "tsx"), "");

		const env = detectEnvironment(cwd);

		expect(env.mode).toBe("development");
		expect(env.canHotReload).toBe(false);
		expect(env.buildCommand).toBeNull();
	});

	it("does not throw on malformed package.json", () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "tsconfig.json"), "{}");
		writeFileSync(join(cwd, "package.json"), "{ not-json");
		mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(cwd, "node_modules", ".bin", "tsx"), "");

		expect(() => detectEnvironment(cwd)).not.toThrow();
		const env = detectEnvironment(cwd);
		expect(env.mode).toBe("development");
		expect(env.canHotReload).toBe(false);
	});
});
