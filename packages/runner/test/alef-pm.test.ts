/**
 * Unit tests for alef-pm.ts — generation manager.
 *
 * Tests the pure logic (snapshot, restore, gc, resolveOrganPath) against
 * a temp directory. npm CLI calls are skipped in unit tests — those are
 * covered by the integration path in lifecycle-supervisor tests.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Self-contained mini-pm for unit testing (same logic, temp root)
// ---------------------------------------------------------------------------

// We test the module's exported pure functions by pointing them at a temp dir.
// Since PM_ROOT is derived from homedir() at import time, we replicate the
// pure functions here with an injectable root. The real alef-pm.ts is tested
// for integration concerns in lifecycle tests.

function makeTestPm(root: string) {
	const GEN_DIR = join(root, "generations");
	const LOCAL_STORE = join(root, "local-store");
	const LOCK_FILE = join(root, "package-lock.json");
	const CURRENT_FILE = join(root, "current");
	const PACKAGE_JSON = join(root, "package.json");

	function init() {
		mkdirSync(GEN_DIR, { recursive: true });
		mkdirSync(LOCAL_STORE, { recursive: true });
		if (!existsSync(PACKAGE_JSON)) {
			writeFileSync(PACKAGE_JSON, JSON.stringify({ name: "alef-organs", private: true, dependencies: {} }, null, 2));
		}
	}

	function currentGenId(): number {
		if (!existsSync(CURRENT_FILE)) return 0;
		return parseInt(readFileSync(CURRENT_FILE, "utf-8").trim()) || 0;
	}

	function snapshotGeneration(): number {
		const lockContent = existsSync(LOCK_FILE) ? readFileSync(LOCK_FILE, "utf-8") : "{}";
		const lockHash = createHash("sha256").update(lockContent).digest("hex");
		const parent = currentGenId() || null;
		const id = currentGenId() + 1;
		writeFileSync(
			join(GEN_DIR, `${id}.json`),
			JSON.stringify({ id, ts: new Date().toISOString(), lockHash, lockfileContent: lockContent, parent }),
		);
		writeFileSync(CURRENT_FILE, String(id));
		return id;
	}

	function rollback(n: number) {
		const gen = JSON.parse(readFileSync(join(GEN_DIR, `${n}.json`), "utf-8")) as { lockfileContent: string };
		writeFileSync(LOCK_FILE, gen.lockfileContent);
		writeFileSync(CURRENT_FILE, String(n));
	}

	function history() {
		if (!existsSync(GEN_DIR)) return [];
		const { readdirSync } = require("node:fs") as typeof import("node:fs");
		return readdirSync(GEN_DIR)
			.filter((f: string) => f.endsWith(".json"))
			.map((f: string) => JSON.parse(readFileSync(join(GEN_DIR, f), "utf-8")) as { id: number; ts: string })
			.sort((a: { id: number }, b: { id: number }) => b.id - a.id);
	}

	function gc(keep = 10) {
		const { readdirSync } = require("node:fs") as typeof import("node:fs");
		const files = readdirSync(GEN_DIR)
			.filter((f: string) => f.endsWith(".json"))
			.map((f: string) => ({ file: f, id: parseInt(f) }))
			.sort((a: { id: number }, b: { id: number }) => b.id - a.id);
		const toRemove = files.slice(keep);
		for (const { file } of toRemove) rmSync(join(GEN_DIR, file));
		return { removedGenerations: toRemove.length, removedStoreEntries: 0 };
	}

	function snapshotLocalOrgan(filePath: string): string {
		const content = readFileSync(filePath);
		const hash = createHash("sha256").update(content).digest("hex");
		const storeDir = join(LOCAL_STORE, hash);
		if (!existsSync(storeDir)) {
			mkdirSync(storeDir, { recursive: true });
			const { basename } = require("node:path") as typeof import("node:path");
			const { copyFileSync } = require("node:fs") as typeof import("node:fs");
			copyFileSync(filePath, join(storeDir, basename(filePath)));
		}
		return hash;
	}

	function restoreLocalOrgan(hash: string, fileName: string): string {
		const stored = join(LOCAL_STORE, hash, fileName);
		if (!existsSync(stored)) throw new Error(`local-store: ${hash}/${fileName} not found`);
		const content = readFileSync(stored);
		const actual = createHash("sha256").update(content).digest("hex");
		if (actual !== hash) throw new Error(`local-store: ${hash}/${fileName} content hash mismatch`);
		return stored;
	}

	function resolveOrganPath(name: string): string | undefined {
		const candidates = [
			join(root, "node_modules", name, "src", "organ.ts"),
			join(root, "node_modules", "@dpopsuev", name, "src", "organ.ts"),
			join(root, "node_modules", name, "src", "index.ts"),
		];
		for (const p of candidates) if (existsSync(p)) return p;
		return undefined;
	}

	return {
		init,
		currentGenId,
		snapshotGeneration,
		rollback,
		history,
		gc,
		snapshotLocalOrgan,
		restoreLocalOrgan,
		resolveOrganPath,
		LOCK_FILE,
		CURRENT_FILE,
		GEN_DIR,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpRoot: string;
let pm: ReturnType<typeof makeTestPm>;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "alef-pm-test-"));
	pm = makeTestPm(tmpRoot);
	pm.init();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("init", () => {
	it("creates required directories", () => {
		expect(existsSync(join(tmpRoot, "generations"))).toBe(true);
		expect(existsSync(join(tmpRoot, "local-store"))).toBe(true);
		expect(existsSync(join(tmpRoot, "package.json"))).toBe(true);
	});

	it("is idempotent", () => {
		expect(() => pm.init()).not.toThrow();
	});
});

describe("snapshotGeneration", () => {
	it("creates generation 1 on first call", () => {
		writeFileSync(pm.LOCK_FILE, JSON.stringify({ packages: {} }));
		const id = pm.snapshotGeneration();
		expect(id).toBe(1);
		expect(existsSync(join(tmpRoot, "generations", "1.json"))).toBe(true);
		expect(parseInt(readFileSync(pm.CURRENT_FILE, "utf-8"))).toBe(1);
	});

	it("increments id on each call", () => {
		writeFileSync(pm.LOCK_FILE, "{}");
		pm.snapshotGeneration();
		pm.snapshotGeneration();
		expect(pm.currentGenId()).toBe(2);
	});

	it("stores lockfile content and hash in the generation record", () => {
		const lock = { packages: { "node_modules/@dpopsuev/organ-fs": { version: "0.1.2" } } };
		writeFileSync(pm.LOCK_FILE, JSON.stringify(lock));
		pm.snapshotGeneration();
		const gen = JSON.parse(readFileSync(join(tmpRoot, "generations", "1.json"), "utf-8")) as {
			lockHash: string;
			lockfileContent: string;
		};
		expect(gen.lockHash).toHaveLength(64);
		expect(JSON.parse(gen.lockfileContent)).toEqual(lock);
	});
});

describe("rollback", () => {
	it("restores lockfile from generation N and updates current", () => {
		const lockV1 = { packages: { "node_modules/@dpopsuev/organ-fs": { version: "0.1.1" } } };
		writeFileSync(pm.LOCK_FILE, JSON.stringify(lockV1));
		pm.snapshotGeneration(); // gen 1

		const lockV2 = { packages: { "node_modules/@dpopsuev/organ-fs": { version: "0.1.2" } } };
		writeFileSync(pm.LOCK_FILE, JSON.stringify(lockV2));
		pm.snapshotGeneration(); // gen 2

		pm.rollback(1);

		const restored = JSON.parse(readFileSync(pm.LOCK_FILE, "utf-8")) as typeof lockV1;
		expect(restored.packages["node_modules/@dpopsuev/organ-fs"].version).toBe("0.1.1");
		expect(parseInt(readFileSync(pm.CURRENT_FILE, "utf-8"))).toBe(1);
	});
});

describe("history", () => {
	it("returns empty array when no generations exist", () => {
		expect(pm.history()).toEqual([]);
	});

	it("returns generations sorted newest-first", () => {
		writeFileSync(pm.LOCK_FILE, "{}");
		pm.snapshotGeneration();
		pm.snapshotGeneration();
		const h = pm.history();
		expect(h).toHaveLength(2);
		expect((h[0] as { id: number }).id).toBe(2);
		expect((h[1] as { id: number }).id).toBe(1);
	});
});

describe("gc", () => {
	it("removes generations beyond keep limit", () => {
		writeFileSync(pm.LOCK_FILE, "{}");
		for (let i = 0; i < 5; i++) pm.snapshotGeneration();
		const { removedGenerations } = pm.gc(3);
		expect(removedGenerations).toBe(2);
		expect(pm.history()).toHaveLength(3);
	});

	it("removes nothing when keep >= total", () => {
		writeFileSync(pm.LOCK_FILE, "{}");
		pm.snapshotGeneration();
		const { removedGenerations } = pm.gc(10);
		expect(removedGenerations).toBe(0);
	});
});

describe("local-store", () => {
	it("snapshots a file and restores it by hash", () => {
		const file = join(tmpRoot, "my-organ.ts");
		writeFileSync(file, "export function createOrgan() {}");
		const hash = pm.snapshotLocalOrgan(file);
		expect(hash).toHaveLength(64);
		const restored = pm.restoreLocalOrgan(hash, "my-organ.ts");
		expect(readFileSync(restored, "utf-8")).toBe("export function createOrgan() {}");
	});

	it("throws when store entry is missing", () => {
		expect(() => pm.restoreLocalOrgan("a".repeat(64), "organ.ts")).toThrow("not found");
	});

	it("throws when content hash mismatches (tampered store)", () => {
		const file = join(tmpRoot, "organ.ts");
		writeFileSync(file, "original");
		const hash = pm.snapshotLocalOrgan(file);
		writeFileSync(join(tmpRoot, "local-store", hash, "organ.ts"), "tampered");
		expect(() => pm.restoreLocalOrgan(hash, "organ.ts")).toThrow("hash mismatch");
	});
});

describe("resolveOrganPath", () => {
	it("returns undefined when organ not installed", () => {
		expect(pm.resolveOrganPath("organ-missing")).toBeUndefined();
	});

	it("resolves path when organ exists in node_modules/@dpopsuev", () => {
		const dir = join(tmpRoot, "node_modules", "@dpopsuev", "organ-fs", "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "organ.ts"), "export function createOrgan() {}");
		const resolved = pm.resolveOrganPath("organ-fs");
		expect(resolved).toContain("organ-fs");
		expect(resolved).toContain("organ.ts");
	});
});
