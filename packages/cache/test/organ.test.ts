import { buildSense } from "@dpopsuev/alef-kernel";
import { NerveFixture, organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCacheOrgan } from "../src/adapter.js";

organComplianceSuite(() => createCacheOrgan());

describe("CacheOrgan", () => {
	let fixture: NerveFixture;
	let cacheOrgan: ReturnType<typeof createCacheOrgan>;

	beforeEach(() => {
		fixture = new NerveFixture();
		cacheOrgan = createCacheOrgan({ ttl: 1000 }); // 1 second TTL for tests
		fixture.mount(cacheOrgan);
	});

	afterEach(() => {
		fixture.dispose();
	});

	test("cache hit: second identical fs.read returns cached result instantly", async () => {
		const results: Array<Record<string, unknown>> = [];

		// Subscribe to sense events
		const unsub = fixture.nerve.asBus().event.subscribe("command/fs.read", (event) => {
			results.push(event.payload);
		});

		// First call - cache miss
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-1",
			payload: { path: "/test/file.txt" },
		});

		// Simulate the fs organ responding
		fixture.nerve
			.asBus()
			.event.publish(
				buildSense(
					{ type: "command/fs.read", correlationId: "corr-1", timestamp: Date.now(), elapsed: 100, payload: {} },
					{ content: "file content", isFinal: true },
				),
			);

		// Wait for async processing
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Second call - cache hit
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-2",
			payload: { path: "/test/file.txt" },
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		unsub();

		// Should have 2 results
		expect(results).toHaveLength(2);
		expect(results[1]).toMatchObject({ content: "file content", _fromCache: true });
	});

	test("cache miss: different payloads are not cached together", async () => {
		const results: Array<Record<string, unknown>> = [];

		const unsub = fixture.nerve.asBus().event.subscribe("command/fs.read", (event) => {
			results.push(event.payload);
		});

		// First call
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-1",
			payload: { path: "/test/file1.txt" },
		});

		fixture.nerve
			.asBus()
			.event.publish(
				buildSense(
					{ type: "command/fs.read", correlationId: "corr-1", timestamp: Date.now(), elapsed: 100, payload: {} },
					{ content: "content 1", isFinal: true },
				),
			);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Second call with different payload
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-2",
			payload: { path: "/test/file2.txt" },
		});

		fixture.nerve
			.asBus()
			.event.publish(
				buildSense(
					{ type: "command/fs.read", correlationId: "corr-2", timestamp: Date.now(), elapsed: 100, payload: {} },
					{ content: "content 2", isFinal: true },
				),
			);

		await new Promise((resolve) => setTimeout(resolve, 10));

		unsub();

		// Should have 2 different results
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ content: "content 1" });
		expect(results[1]).toMatchObject({ content: "content 2" });
	});

	test("TTL expiry: cached entry expires after TTL", async () => {
		const results: Array<Record<string, unknown>> = [];

		const unsub = fixture.nerve.asBus().event.subscribe("command/fs.read", (event) => {
			results.push(event.payload);
		});

		// First call
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-1",
			payload: { path: "/test/file.txt" },
		});

		fixture.nerve
			.asBus()
			.event.publish(
				buildSense(
					{ type: "command/fs.read", correlationId: "corr-1", timestamp: Date.now(), elapsed: 100, payload: {} },
					{ content: "original", isFinal: true },
				),
			);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Wait for TTL to expire (1 second + buffer)
		await new Promise((resolve) => setTimeout(resolve, 1100));

		// Second call after expiry
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-2",
			payload: { path: "/test/file.txt" },
		});

		fixture.nerve
			.asBus()
			.event.publish(
				buildSense(
					{ type: "command/fs.read", correlationId: "corr-2", timestamp: Date.now(), elapsed: 100, payload: {} },
					{ content: "refreshed", isFinal: true },
				),
			);

		await new Promise((resolve) => setTimeout(resolve, 10));

		unsub();

		// Should have 2 results, second is not from cache
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ content: "original" });
		expect(results[1]).toMatchObject({ content: "refreshed" });
		expect(results[1]._fromCache).toBeUndefined();
	});

	test("invalidation: fs.write invalidates fs.read cache", async () => {
		const results: Array<Record<string, unknown>> = [];

		const unsub = fixture.nerve.asBus().event.subscribe("command/fs.read", (event) => {
			results.push(event.payload);
		});

		// First fs.read - cache miss
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-1",
			payload: { path: "/test/file.txt" },
		});

		fixture.nerve
			.asBus()
			.event.publish(
				buildSense(
					{ type: "command/fs.read", correlationId: "corr-1", timestamp: Date.now(), elapsed: 100, payload: {} },
					{ content: "before write", isFinal: true },
				),
			);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// fs.write - invalidates cache
		fixture.nerve.asBus().command.publish({
			type: "command/fs.write",
			correlationId: "corr-write",
			payload: { path: "/test/file.txt", content: "new content" },
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Second fs.read - should be cache miss after invalidation
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-2",
			payload: { path: "/test/file.txt" },
		});

		fixture.nerve
			.asBus()
			.event.publish(
				buildSense(
					{ type: "command/fs.read", correlationId: "corr-2", timestamp: Date.now(), elapsed: 100, payload: {} },
					{ content: "after write", isFinal: true },
				),
			);

		await new Promise((resolve) => setTimeout(resolve, 10));

		unsub();

		// Should have 2 results, second is not from cache
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ content: "before write" });
		expect(results[1]).toMatchObject({ content: "after write" });
		expect(results[1]._fromCache).toBeUndefined();
	});

	test("cache.invalidate tool: explicit invalidation", async () => {
		// Set up fs.read cache
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-1",
			payload: { path: "/test/file.txt" },
		});

		fixture.nerve
			.asBus()
			.event.publish(
				buildSense(
					{ type: "command/fs.read", correlationId: "corr-1", timestamp: Date.now(), elapsed: 100, payload: {} },
					{ content: "cached", isFinal: true },
				),
			);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Call cache.invalidate
		const result = await fixture.call("cache.invalidate", { tools: ["fs.read"] });

		expect(result.payload).toMatchObject({
			invalidated: 1,
			tools: ["command/fs.read"],
		});
	});

	test("cache.stats tool: reports metrics", async () => {
		// Generate some cache activity
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-1",
			payload: { path: "/test/file.txt" },
		});

		fixture.nerve
			.asBus()
			.event.publish(
				buildSense(
					{ type: "command/fs.read", correlationId: "corr-1", timestamp: Date.now(), elapsed: 100, payload: {} },
					{ content: "cached", isFinal: true },
				),
			);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Hit the cache
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-2",
			payload: { path: "/test/file.txt" },
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Call cache.stats
		const result = await fixture.call("cache.stats", {});

		expect(result.payload).toMatchObject({
			total: 2,
			hits: 1,
			misses: 1,
			hitRate: 50.0,
			size: 1,
		});
	});

	test("toolCallId filtered from cache key", async () => {
		const results: Array<Record<string, unknown>> = [];

		const unsub = fixture.nerve.asBus().event.subscribe("command/fs.read", (event) => {
			results.push(event.payload);
		});

		// First call with toolCallId
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-1",
			payload: { path: "/test/file.txt", toolCallId: "tool-1" },
		});

		fixture.nerve
			.asBus()
			.event.publish(
				buildSense(
					{ type: "command/fs.read", correlationId: "corr-1", timestamp: Date.now(), elapsed: 100, payload: {} },
					{ content: "content", isFinal: true },
				),
			);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Second call with different toolCallId but same path - should hit cache
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-2",
			payload: { path: "/test/file.txt", toolCallId: "tool-2" },
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		unsub();

		// Should have 2 results, second from cache
		expect(results).toHaveLength(2);
		expect(results[1]).toMatchObject({ content: "content", _fromCache: true });
	});

	test("errors are not cached", async () => {
		const results: Array<Record<string, unknown>> = [];

		const unsub = fixture.nerve.asBus().event.subscribe("command/fs.read", (event) => {
			results.push(event.payload);
		});

		// First call results in error
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-1",
			payload: { path: "/test/missing.txt" },
		});

		fixture.nerve.asBus().event.publish({
			type: "command/fs.read",
			correlationId: "corr-1",
			payload: { error: "file not found", isFinal: true },
			isError: true,
			errorMessage: "file not found",
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Second call with same payload
		fixture.nerve.asBus().command.publish({
			type: "command/fs.read",
			correlationId: "corr-2",
			payload: { path: "/test/missing.txt" },
		});

		fixture.nerve
			.asBus()
			.event.publish(
				buildSense(
					{ type: "command/fs.read", correlationId: "corr-2", timestamp: Date.now(), elapsed: 100, payload: {} },
					{ content: "now exists", isFinal: true },
				),
			);

		await new Promise((resolve) => setTimeout(resolve, 10));

		unsub();

		// Should have 2 results, second is not from cache
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ error: "file not found" });
		expect(results[1]).toMatchObject({ content: "now exists" });
		expect(results[1]._fromCache).toBeUndefined();
	});
});
