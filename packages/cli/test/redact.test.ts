import { REDACTED, redactPayload, reveal, Sensitive } from "@dpopsuev/alef-session/redact";
import { describe, expect, it } from "vitest";

describe("Sensitive — producer marker", { tags: ["unit"] }, () => {
	it("reveal returns the wrapped value", () => {
		expect(reveal(Sensitive("s3cr3t"))).toBe("s3cr3t");
		expect(reveal("plain")).toBe("plain");
	});

	it("toJSON redacts so accidental stringify cannot leak", () => {
		expect(JSON.stringify({ apiKey: Sensitive("super-secret") })).toBe(`{"apiKey":"${REDACTED}"}`);
	});
});

describe("redactPayload — producer-marked secrets only", { tags: ["unit"] }, () => {
	it("redacts Sensitive values and preserves unmarked fields", () => {
		const result = redactPayload({
			password: Sensitive("s3cr3t"),
			username: "alice",
			totalTokens: 20_000,
		}) as Record<string, unknown>;
		expect(result.password).toBe(REDACTED);
		expect(result.username).toBe("alice");
		expect(result.totalTokens).toBe(20_000);
	});

	it("does not redact unmarked keys that look sensitive by name", () => {
		const result = redactPayload({
			password: "still-visible-without-marker",
			apiKey: "also-visible",
			token: "also-visible",
		}) as Record<string, unknown>;
		expect(result.password).toBe("still-visible-without-marker");
		expect(result.apiKey).toBe("also-visible");
		expect(result.token).toBe("also-visible");
	});

	it("deep-scans nested Sensitive markers", () => {
		const result = redactPayload({ outer: { apiKey: Sensitive("secret") } }) as Record<string, unknown>;
		const outer = result.outer as Record<string, unknown>;
		expect(outer.apiKey).toBe(REDACTED);
	});

	it("scans arrays element-by-element", () => {
		const result = redactPayload([{ token: Sensitive("abc") }, { path: "/tmp" }]) as Record<string, unknown>[];
		expect(result[0]!.token).toBe(REDACTED);
		expect(result[1]!.path).toBe("/tmp");
	});

	it("leaves non-object scalars unchanged", () => {
		expect(redactPayload("plain string")).toBe("plain string");
		expect(redactPayload(42)).toBe(42);
		expect(redactPayload(null)).toBeNull();
	});

	it("returns new object — original not mutated", () => {
		const original = { password: Sensitive("secret"), name: "alice" };
		redactPayload(original);
		expect(reveal(original.password)).toBe("secret");
	});

	it("preserves LLM usage metrics without markers", () => {
		const result = redactPayload({
			usage: {
				input: 10,
				output: 200,
				totalTokens: 20_000,
				maxTokens: 8_192,
			},
		}) as Record<string, unknown>;
		const usage = result.usage as Record<string, unknown>;
		expect(usage.totalTokens).toBe(20_000);
		expect(usage.maxTokens).toBe(8_192);
	});
});

describe("hashRecord", { tags: ["unit"] }, () => {
	it("produces a 64-char hex string", async () => {
		const { hashRecord } = await import("@dpopsuev/alef-session/storage");
		const hash = hashRecord({
			bus: "command",
			type: "fs.read",
			correlationId: "c-1",
			timestamp: 0,
			payload: { path: "auth.ts" },
		});
		expect(hash).toMatch(/^[0-9a-f]{16}$/);
	});

	it("same record produces same hash", async () => {
		const { hashRecord } = await import("@dpopsuev/alef-session/storage");
		const base = {
			bus: "command" as const,
			type: "fs.read",
			correlationId: "c-1",
			timestamp: 0,
			payload: { path: "a.ts" },
		};
		expect(hashRecord(base)).toBe(hashRecord(base));
	});

	it("different payloads produce different hashes", async () => {
		const { hashRecord } = await import("@dpopsuev/alef-session/storage");
		const h1 = hashRecord({
			bus: "command",
			type: "fs.read",
			correlationId: "c-1",
			timestamp: 0,
			payload: { path: "a.ts" },
		});
		const h2 = hashRecord({
			bus: "command",
			type: "fs.read",
			correlationId: "c-1",
			timestamp: 0,
			payload: { path: "b.ts" },
		});
		expect(h1).not.toBe(h2);
	});

	it("modifying type changes the hash (tamper detection)", async () => {
		const { hashRecord } = await import("@dpopsuev/alef-session/storage");
		const h1 = hashRecord({ bus: "command", type: "fs.read", correlationId: "c-1", payload: {}, timestamp: 0 });
		const h2 = hashRecord({ bus: "command", type: "fs.WRITE", correlationId: "c-1", payload: {}, timestamp: 0 });
		expect(h1).not.toBe(h2);
	});
});

describe("SessionLog integration — redact + hash", { tags: ["unit"] }, () => {
	it("appended record has hash and redacted Sensitive payload", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const { InProcessBus } = await import("../../core/kernel/src/bus/in-process-bus.js");
		const { SessionLog } = await import("@dpopsuev/alef-agent/event-log");
		const { JsonlSessionStore } = await import("@dpopsuev/alef-session/store");

		const cwd = mkdtempSync(join(tmpdir(), "alef-audit-"));
		try {
			const store = await JsonlSessionStore.create(cwd);
			const adapter = new SessionLog(store);
			const nerve = new InProcessBus();
			adapter.mount(nerve.asBus());

			nerve.asBus().command.publish({
				type: "test.event",
				payload: { command: "echo hi", apiKey: Sensitive("super-secret"), path: "/tmp" },
				correlationId: "c-1",
			});

			await new Promise((r) => setTimeout(r, 50));

			const events = await store.events();
			expect(events.length).toBeGreaterThan(0);

			const record = events.find((e) => e.type === "test.event" && e.bus === "command");
			expect(record).toBeDefined();
			expect(record!.hash).toMatch(/^[0-9a-f]{16}$/);
			expect(record!.payload.apiKey).toBe("[REDACTED]");
			expect(record!.payload.command).toBe("echo hi");
			expect(record!.payload.path).toBe("/tmp");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
