/**
 * Tests for alef-pm.ts — the real module, ALEF_PM_ROOT injected.
 *
 * Unit/robustness: ALEF_PM_SKIP_NPM=1 skips npm CLI calls. vi.spyOn(module,
 * "runNpm") verifies correct commands are passed without actually running npm.
 *
 * Integration (ALEF_PM_INTEGRATION=1): real npm, real lockfile, real cache.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "alef-pm-real-"));
	process.env.ALEF_PM_ROOT = tmpRoot;
	process.env.ALEF_PM_SKIP_NPM = "1";
	vi.resetModules();
});

afterEach(() => {
	delete process.env.ALEF_PM_ROOT;
	delete process.env.ALEF_PM_SKIP_NPM;
	vi.restoreAllMocks();
	rmSync(tmpRoot, { recursive: true, force: true });
});

async function load() {
	return import("../src/alef-pm.js");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeLock(content: object): void {
	writeFileSync(join(tmpRoot, "package-lock.json"), JSON.stringify(content, null, 2));
}

function readCurrent(): number {
	return parseInt(readFileSync(join(tmpRoot, "current"), "utf-8").trim(), 10);
}

function readGen(id: number) {
	return JSON.parse(readFileSync(join(tmpRoot, "generations", `${id}.json`), "utf-8")) as {
		id: number;
		lockHash: string;
		lockfileContent: string;
		parent: number | null;
	};
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe("init", { tags: ["unit"] }, () => {
	it("creates directories and package.json", async () => {
		const { init } = await load();
		init();
		expect(existsSync(join(tmpRoot, "generations"))).toBe(true);
		expect(existsSync(join(tmpRoot, "local-store"))).toBe(true);
		expect(existsSync(join(tmpRoot, "package.json"))).toBe(true);
	});

	it("is idempotent", async () => {
		const { init } = await load();
		init();
		expect(() => init()).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// npm operations — verify state effects (SKIP_NPM so no real execution)
// ESM closures prevent spying on runNpm internally; assert output state instead.
// ---------------------------------------------------------------------------

describe("install", { tags: ["unit"] }, () => {
	it("writes generation 1 after organ install", async () => {
		const { init, install } = await load();
		init();
		writeLock({});
		const id = await install("@dpopsuev/organ-fs");
		expect(id).toBe(1);
		expect(readCurrent()).toBe(1);
		expect(existsSync(join(tmpRoot, "generations", "1.json"))).toBe(true);
	});

	it("records lockfile in generation", async () => {
		const { init, install } = await load();
		init();
		const lock = { packages: { "node_modules/@dpopsuev/organ-fs": { version: "0.1.2" } } };
		writeLock(lock);
		await install("@dpopsuev/organ-fs");
		const gen = readGen(1);
		expect(JSON.parse(gen.lockfileContent)).toMatchObject(lock);
	});
});

describe("upgrade", { tags: ["unit"] }, () => {
	it("writes next generation after upgrade", async () => {
		const { init, upgrade } = await load();
		init();
		writeLock({ v: 1 });
		await upgrade();
		expect(readCurrent()).toBe(1);
	});
});

describe("remove", { tags: ["unit"] }, () => {
	it("writes next generation after remove", async () => {
		const { init, upgrade, remove } = await load();
		init();
		writeLock({ v: 1 });
		await upgrade(); // gen 1
		writeLock({ v: 2 });
		await remove("adapter-fs"); // gen 2
		expect(readCurrent()).toBe(2);
	});
});

describe("rollback", { tags: ["unit"] }, () => {
	it("restores lockfile from generation N and updates current", async () => {
		const { init, upgrade, rollback } = await load();
		init();
		const lockV1 = { packages: { "node_modules/organ-fs": { version: "0.1.1" } } };
		writeLock(lockV1);
		await upgrade(); // gen 1
		writeLock({ packages: { "node_modules/organ-fs": { version: "0.1.2" } } });
		await upgrade(); // gen 2

		await rollback(1);

		const restored = JSON.parse(readFileSync(join(tmpRoot, "package-lock.json"), "utf-8")) as typeof lockV1;
		expect(restored.packages["node_modules/organ-fs"].version).toBe("0.1.1");
		expect(readCurrent()).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Generation mechanics — no npm needed
// ---------------------------------------------------------------------------

describe("generation lifecycle", { tags: ["unit"] }, () => {
	it("increments id on each operation", async () => {
		const { init, upgrade } = await load();
		init();
		writeLock({ v: 1 });
		await upgrade();
		expect(readCurrent()).toBe(1);
		writeLock({ v: 2 });
		await upgrade();
		expect(readCurrent()).toBe(2);
	});

	it("records lockfile content, hash, and parent", async () => {
		const { init, upgrade } = await load();
		init();
		writeLock({ packages: { "node_modules/organ-fs": { version: "0.1.2" } } });
		await upgrade(); // gen 1
		writeLock({ packages: { "node_modules/organ-fs": { version: "0.1.3" } } });
		await upgrade(); // gen 2
		const gen2 = readGen(2);
		expect(gen2.parent).toBe(1);
		expect(gen2.lockHash).toHaveLength(64);
		expect(JSON.parse(gen2.lockfileContent).packages["node_modules/organ-fs"].version).toBe("0.1.3");
	});
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("history", { tags: ["unit"] }, () => {
	it("returns empty when no generations", async () => {
		const { init, history } = await load();
		init();
		expect(history()).toEqual([]);
	});

	it("sorted newest-first", async () => {
		const { init, upgrade, history } = await load();
		init();
		writeLock({});
		await upgrade();
		await upgrade();
		const h = history();
		expect(h).toHaveLength(2);
		expect(h[0].id).toBe(2);
		expect(h[1].id).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// GC
// ---------------------------------------------------------------------------

describe("gc", { tags: ["unit"] }, () => {
	it("removes generations beyond keep limit", async () => {
		const { init, upgrade, gc, history } = await load();
		init();
		writeLock({});
		for (let i = 0; i < 5; i++) await upgrade();
		expect(gc(3).removedGenerations).toBe(2);
		expect(history()).toHaveLength(3);
	});

	it("no-op when keep >= total", async () => {
		const { init, upgrade, gc } = await load();
		init();
		writeLock({});
		await upgrade();
		expect(gc(10).removedGenerations).toBe(0);
	});

	it("no-op on fresh init", async () => {
		const { init, gc } = await load();
		init();
		expect(gc().removedGenerations).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe("robustness", { tags: ["unit"] }, () => {
	it("corrupted `current` falls back to 0 — next gen is 1", async () => {
		const { init, upgrade } = await load();
		init();
		writeFileSync(join(tmpRoot, "current"), "not-a-number");
		writeLock({});
		expect(await upgrade()).toBe(1);
	});

	it("rollback to non-existent generation throws", async () => {
		const { init, rollback } = await load();
		init();
		await expect(rollback(99)).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Local store
// ---------------------------------------------------------------------------

describe("local-store", { tags: ["unit"] }, () => {
	it("snapshots and restores by hash", async () => {
		const { init, snapshotLocalOrgan, restoreLocalOrgan } = await load();
		init();
		const file = join(tmpRoot, "organ.ts");
		writeFileSync(file, "export function createOrgan() {}");
		const hash = snapshotLocalOrgan(file);
		expect(hash).toHaveLength(64);
		expect(readFileSync(restoreLocalOrgan(hash, "organ.ts"), "utf-8")).toBe("export function createOrgan() {}");
	});

	it("restoreLocalOrgan throws when missing", async () => {
		const { init, restoreLocalOrgan } = await load();
		init();
		expect(() => restoreLocalOrgan("a".repeat(64), "organ.ts")).toThrow("not found");
	});

	it("restoreLocalOrgan throws on tampered content", async () => {
		const { init, snapshotLocalOrgan, restoreLocalOrgan } = await load();
		init();
		const file = join(tmpRoot, "organ.ts");
		writeFileSync(file, "original");
		const hash = snapshotLocalOrgan(file);
		writeFileSync(join(tmpRoot, "local-store", hash, "organ.ts"), "tampered");
		expect(() => restoreLocalOrgan(hash, "organ.ts")).toThrow("hash mismatch");
	});
});

// ---------------------------------------------------------------------------
// resolveOrganPath
// ---------------------------------------------------------------------------

describe("resolveOrganPath", { tags: ["unit"] }, () => {
	it("returns undefined when not installed", async () => {
		const { init, resolveOrganPath } = await load();
		init();
		expect(resolveOrganPath("organ-missing")).toBeUndefined();
	});

	it("resolves under @dpopsuev namespace", async () => {
		const { init, resolveOrganPath } = await load();
		init();
		const dir = join(tmpRoot, "node_modules", "@dpopsuev", "organ-fs", "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "organ.ts"), "");
		expect(resolveOrganPath("organ-fs")).toContain("organ.ts");
	});

	it("resolves directly under node_modules", async () => {
		const { init, resolveOrganPath } = await load();
		init();
		const dir = join(tmpRoot, "node_modules", "my-organ", "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "organ.ts"), "");
		expect(resolveOrganPath("my-organ")).toContain("my-organ");
	});
});

// ---------------------------------------------------------------------------
// Integration — real npm (ALEF_PM_INTEGRATION=1)
// ---------------------------------------------------------------------------

describe.skipIf(process.env.ALEF_PM_INTEGRATION !== "1")("integration — real npm", () => {
	beforeEach(() => {
		delete process.env.ALEF_PM_SKIP_NPM;
	});

	it("install writes lockfile with sha512 integrity", async () => {
		const { init, install } = await load();
		init();
		await install("semver");
		const lock = JSON.parse(readFileSync(join(tmpRoot, "package-lock.json"), "utf-8")) as {
			packages: Record<string, { integrity?: string }>;
		};
		const entry = Object.values(lock.packages).find((p) => p.integrity);
		expect(entry?.integrity).toMatch(/^sha512-/);
	}, 60_000);

	it("rollback restores exact version via npm ci", async () => {
		const { init, install, upgrade, rollback } = await load();
		init();
		await install("semver");
		const lockAfter = readFileSync(join(tmpRoot, "package-lock.json"), "utf-8");
		await upgrade();
		await rollback(1);
		expect(readFileSync(join(tmpRoot, "package-lock.json"), "utf-8")).toBe(lockAfter);
		expect(readCurrent()).toBe(1);
	}, 120_000);
});
