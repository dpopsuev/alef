import { chmodSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryToolResultCache } from "../src/cache.js";
import { executeFindQuery, executeGrepQuery } from "../src/file-queries.js";

// ---------------------------------------------------------------------------
// Signal / abort tests — cover the lifecycle wiring that a module split must
// preserve: pre-abort check, settler cleanup, abort listener registration.
// ---------------------------------------------------------------------------

describe("executeFindQuery — abort wiring", { tags: ["unit"] }, () => {
	it("rejects immediately when signal is pre-aborted", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(executeFindQuery({ pattern: "*.ts" }, { cwd: tmpdir(), signal: ctrl.signal })).rejects.toThrow(
			/operation was aborted|operation aborted/i,
		);
	});

	it("rejects when signal aborts during resolveFdPath", async () => {
		const ctrl = new AbortController();
		let resolveCount = 0;
		await expect(
			executeFindQuery(
				{ pattern: "*.ts" },
				{
					cwd: tmpdir(),
					signal: ctrl.signal,
					resolveFdPath: async () => {
						resolveCount++;
						ctrl.abort();
						return "fd-that-does-not-exist";
					},
				},
			),
		).rejects.toThrow(/operation was aborted|operation aborted/i);
		expect(resolveCount).toBe(1);
	});
});

describe("executeGrepQuery — abort wiring", { tags: ["unit"] }, () => {
	it("rejects immediately when signal is pre-aborted", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(executeGrepQuery({ pattern: "foo" }, { cwd: tmpdir(), signal: ctrl.signal })).rejects.toThrow(
			/operation was aborted|operation aborted/i,
		);
	});
});

describe("executeGrepQuery — cache + single-file in-process", { tags: ["unit"] }, () => {
	it("serves second identical grep from cache", async () => {
		const filePath = join(tmpdir(), `grep-cache-${Date.now()}.txt`);
		writeFileSync(filePath, "alpha\nbeta\nalpha again\n");
		const cache = new InMemoryToolResultCache({ ttlMs: 1_000 });
		let reads = 0;
		const ops = {
			isDirectory: () => false,
			readFile: () => {
				reads++;
				return "alpha\nbeta\nalpha again\n";
			},
		};
		const opts = {
			cwd: tmpdir(),
			cache,
			operations: ops,
			resolveRgPath: async () => {
				throw new Error("should not spawn rg for single-file grep");
			},
		};

		const r1 = await executeGrepQuery({ pattern: "alpha", path: filePath }, opts);
		expect(reads).toBe(1);
		expect(r1.details?.inProcess).toBe(true);
		expect(r1.content[0]!.text).toContain("alpha");

		const r2 = await executeGrepQuery({ pattern: "alpha", path: filePath }, opts);
		expect(reads).toBe(1);
		expect(r2.details?.cache?.hit).toBe(true);
		expect(r2.content[0]!.text).toEqual(r1.content[0]!.text);
	});

	it("matches a single file in-process without spawning rg", async () => {
		const filePath = join(tmpdir(), `grep-inplace-${Date.now()}.ts`);
		writeFileSync(filePath, 'const foo = 1;\nconst bar = 2;\n');
		let spawned = false;
		const result = await executeGrepQuery(
			{ pattern: "foo", path: filePath, literal: true },
			{
				cwd: tmpdir(),
				resolveRgPath: async () => {
					spawned = true;
					return "rg";
				},
			},
		);
		expect(spawned).toBe(false);
		expect(result.details?.inProcess).toBe(true);
		expect(result.content[0]!.text).toMatch(/foo/);
	});
});

describe("FsRuntime — shared grep/find cache", { tags: ["unit"] }, () => {
	it("shares one cache instance between grep and find scopes", async () => {
		const { FsRuntime, DEFAULT_FS_CACHE_TTL_MS } = await import("../src/fs-runtime.js");
		expect(DEFAULT_FS_CACHE_TTL_MS).toBe(1_000);
		const runtime = new FsRuntime();
		expect(runtime.getCache("grep")).toBe(runtime.getCache("find"));
		expect(runtime.getCache("ls")).not.toBe(runtime.getCache("grep"));
	});
});

// ---------------------------------------------------------------------------
// Cache hit tests — cover withCacheHit<D> path that a module split must
// preserve: a stale import of withCacheHit silently serves undefined instead
// of the cached result, causing a silent cache miss.
// ---------------------------------------------------------------------------

describe("executeFindQuery — cache hit", { tags: ["unit"] }, () => {
	it("serves result from cache on second call with same input", async () => {
		const cache = new InMemoryToolResultCache({ ttlMs: 60_000 });
		let callCount = 0;
		const ops = {
			exists: () => true,
			glob: async () => {
				callCount++;
				return ["a.ts", "b.ts"];
			},
		};
		const opts = { cwd: "/tmp", operations: ops, cache };

		const r1 = await executeFindQuery({ pattern: "*.ts" }, opts);
		expect(callCount).toBe(1);

		const r2 = await executeFindQuery({ pattern: "*.ts" }, opts);
		expect(callCount).toBe(1);
		expect(r2.details?.cache?.hit).toBe(true);
		expect(r2.content[0]!.text).toEqual(r1.content[0]!.text);
	});

	it("does not serve from cache when input differs", async () => {
		const cache = new InMemoryToolResultCache({ ttlMs: 60_000 });
		let callCount = 0;
		const ops = {
			exists: () => true,
			glob: async () => {
				callCount++;
				return ["x.ts"];
			},
		};
		const opts = { cwd: "/tmp", operations: ops, cache };

		await executeFindQuery({ pattern: "*.ts" }, opts);
		await executeFindQuery({ pattern: "*.js" }, opts);
		expect(callCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Subprocess timeout — reproduces the 149s hang seen in production.
// The fd process never exits; the 30s hard kill must fire and reject.
// subprocessTimeoutMs is set to 300ms so the test completes in ~300ms.
// ---------------------------------------------------------------------------

describe("executeFindQuery — subprocess hang", { tags: ["unit"] }, () => {
	it("rejects when the fd subprocess never exits", async () => {
		// A script that sleeps forever — simulates fd scanning a massive tree.
		const fakeScript = join(tmpdir(), `fake-fd-hang-${Date.now()}.sh`);
		writeFileSync(fakeScript, "#!/bin/sh\nsleep 999\n");
		chmodSync(fakeScript, 0o755);

		const start = Date.now();
		await expect(
			executeFindQuery(
				{ pattern: "*.ts" },
				{
					cwd: tmpdir(),
					resolveFdPath: async () => fakeScript,
					subprocessTimeoutMs: 300,
				},
			),
		).rejects.toThrow(/timed out/i);

		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThan(250); // actually waited for the timeout
		expect(elapsed).toBeLessThan(2_000); // but not for 30s

		await rm(fakeScript, { force: true });
	}, 5_000);
});
