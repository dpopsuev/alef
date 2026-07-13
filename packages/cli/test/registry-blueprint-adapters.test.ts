/**
 * Regression: selecting a registry blueprint name (picker / --blueprint coding)
 * must not wipe domain adapters. Previously loadAdapters treated the registry
 * name as a missing file path and returned adapters: [].
 *
 * Symptom: tools.describe([]) → only agent/factory/skills; fs/shell absent;
 * agent.run(explore) still works because explore strategies materialize separately.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAdapters } from "../src/boot/adapters.js";
import type { Args } from "../src/boot/args.js";
import type { AlefConfig } from "../src/boot/config.js";

const log = {
	info: vi.fn(),
	child: () => log,
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as never;

function baseArgs(cwd: string, overlay: Partial<Args> = {}): Args {
	return {
		cwd,
		print: true,
		json: false,
		noTui: true,
		yolo: false,
		...overlay,
	} as Args;
}

const cfg = {} as AlefConfig;

/**
 * Smoke: unknown registry names must never return adapters: [].
 * Canonical SBOM assertions for alef-coding-agent / alef-factory-agent live in
 * singular-blueprint-owner.test.ts.
 */
describe("loadAdapters registry blueprint selection", { tags: ["unit"] }, () => {
	const dirs: string[] = [];
	const registered: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
		registered.splice(0);
	});

	it("registry name must not return adapters: []", async () => {
		const name = `test-bp-${Date.now()}`;
		blueprintRegistry.register(name, async () => ({ adapters: [], contextAssembly: undefined as never }));
		registered.push(name);

		const cwd = mkdtempSync(join(tmpdir(), "alef-adapters-"));
		dirs.push(cwd);

		const result = await loadAdapters(baseArgs(cwd, { blueprint: name }), cfg, log);

		expect(result.blueprintName).toBe(name);
		expect(result.adapters.length, "domain adapters must not be empty for a registry blueprint").toBeGreaterThan(0);
	});

	it("registry name still merges cwd agent.yaml overlay (blockedPatterns etc.)", async () => {
		const name = `test-bp-overlay-${Date.now()}`;
		blueprintRegistry.register(name, async () => ({ adapters: [], contextAssembly: undefined as never }));
		registered.push(name);

		const cwd = mkdtempSync(join(tmpdir(), "alef-adapters-"));
		dirs.push(cwd);
		writeFileSync(
			join(cwd, "agent.yaml"),
			`name: project\nadapters:\n  - name: shell\n    blockedPatterns:\n      - "HUSKY=0"\n`,
		);

		const result = await loadAdapters(baseArgs(cwd, { blueprint: name }), cfg, log);
		expect(result.adapters.some((a) => a.name === "shell")).toBe(true);
		expect(result.adapters.some((a) => a.name === "fs")).toBe(true);
	});
});
