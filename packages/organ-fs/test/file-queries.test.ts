import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { InMemoryToolResultCache } from "../src/cache.js";
import { executeFindQuery, executeGrepQuery } from "../src/file-queries.js";

// ---------------------------------------------------------------------------
// Signal / abort tests — cover the lifecycle wiring that a module split must
// preserve: pre-abort check, settler cleanup, abort listener registration.
// ---------------------------------------------------------------------------

describe("executeFindQuery — abort wiring", () => {
	it("rejects immediately when signal is pre-aborted", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(executeFindQuery({ pattern: "*.ts" }, { cwd: tmpdir(), signal: ctrl.signal })).rejects.toThrow(
			"Operation aborted",
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
		).rejects.toThrow("Operation aborted");
		expect(resolveCount).toBe(1);
	});
});

describe("executeGrepQuery — abort wiring", () => {
	it("rejects immediately when signal is pre-aborted", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(executeGrepQuery({ pattern: "foo" }, { cwd: tmpdir(), signal: ctrl.signal })).rejects.toThrow(
			"Operation aborted",
		);
	});
});

// ---------------------------------------------------------------------------
// Cache hit tests — cover withCacheHit<D> path that a module split must
// preserve: a stale import of withCacheHit silently serves undefined instead
// of the cached result, causing a silent cache miss.
// ---------------------------------------------------------------------------

describe("executeFindQuery — cache hit", () => {
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
		expect(r2.content[0].text).toEqual(r1.content[0].text);
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
