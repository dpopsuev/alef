import { describe, expect, it } from "vitest";
import { DEFAULT_SENSITIVE_KEYS, REDACTED, redactPayload } from "../src/redact.js";

describe("redactPayload — sensitive key detection", { tags: ["unit"] }, () => {
	it("redacts exact sensitive key names", () => {
		const result = redactPayload({ password: "s3cr3t", username: "alice" });
		expect((result as Record<string, unknown>).password).toBe(REDACTED);
		expect((result as Record<string, unknown>).username).toBe("alice");
	});

	it("redacts case-insensitively (Password, PASSWORD)", () => {
		const result = redactPayload({ Password: "x", PASSWORD: "y" }) as Record<string, unknown>;
		expect(result.Password).toBe(REDACTED);
		expect(result.PASSWORD).toBe(REDACTED);
	});

	it("redacts substring matches (myApiKey, user_password)", () => {
		const result = redactPayload({ myApiKey: "abc", user_password: "xyz" }) as Record<string, unknown>;
		expect(result.myApiKey).toBe(REDACTED);
		expect(result.user_password).toBe(REDACTED);
	});

	it("does not redact non-sensitive keys", () => {
		const result = redactPayload({ command: "echo hi", path: "/tmp/a.ts", content: "code" }) as Record<
			string,
			unknown
		>;
		expect(result.command).toBe("echo hi");
		expect(result.path).toBe("/tmp/a.ts");
		expect(result.content).toBe("code");
	});

	it("deep-scans nested objects", () => {
		const result = redactPayload({ outer: { apiKey: "secret" } }) as Record<string, unknown>;
		const outer = result.outer as Record<string, unknown>;
		expect(outer.apiKey).toBe(REDACTED);
	});

	it("scans arrays element-by-element", () => {
		const result = redactPayload([{ token: "abc" }, { path: "/tmp" }]) as Record<string, unknown>[];
		expect(result[0].token).toBe(REDACTED);
		expect(result[1].path).toBe("/tmp");
	});

	it("leaves non-object scalars unchanged", () => {
		expect(redactPayload("plain string")).toBe("plain string");
		expect(redactPayload(42)).toBe(42);
		expect(redactPayload(null)).toBeNull();
	});

	it("returns new object — original not mutated", () => {
		const original = { password: "secret", name: "alice" };
		redactPayload(original);
		expect(original.password).toBe("secret"); // unchanged
	});

	it("covers all DEFAULT_SENSITIVE_KEYS", () => {
		const payload: Record<string, string> = {};
		for (const key of DEFAULT_SENSITIVE_KEYS) {
			payload[key] = "value";
		}
		const result = redactPayload(payload) as Record<string, unknown>;
		for (const key of DEFAULT_SENSITIVE_KEYS) {
			expect(result[key], `key '${key}' should be redacted`).toBe(REDACTED);
		}
	});
});

describe("hashRecord", { tags: ["unit"] }, () => {
	it("produces a 64-char hex string", async () => {
		const { hashRecord } = await import("../src/session-store.js");
		const hash = hashRecord({
			bus: "motor",
			type: "fs.read",
			correlationId: "c-1",
			timestamp: 0,
			payload: { path: "auth.ts" },
		});
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("same record produces same hash", async () => {
		const { hashRecord } = await import("../src/session-store.js");
		const base = {
			bus: "motor" as const,
			type: "fs.read",
			correlationId: "c-1",
			timestamp: 0,
			payload: { path: "a.ts" },
		};
		expect(hashRecord(base)).toBe(hashRecord(base));
	});

	it("different payloads produce different hashes", async () => {
		const { hashRecord } = await import("../src/session-store.js");
		const h1 = hashRecord({
			bus: "motor",
			type: "fs.read",
			correlationId: "c-1",
			timestamp: 0,
			payload: { path: "a.ts" },
		});
		const h2 = hashRecord({
			bus: "motor",
			type: "fs.read",
			correlationId: "c-1",
			timestamp: 0,
			payload: { path: "b.ts" },
		});
		expect(h1).not.toBe(h2);
	});

	it("modifying type changes the hash (tamper detection)", async () => {
		const { hashRecord } = await import("../src/session-store.js");
		const h1 = hashRecord({ bus: "motor", type: "fs.read", correlationId: "c-1", payload: {}, timestamp: 0 });
		const h2 = hashRecord({ bus: "motor", type: "fs.WRITE", correlationId: "c-1", payload: {}, timestamp: 0 });
		expect(h1).not.toBe(h2);
	});
});

describe("SessionLog integration — redact + hash", { tags: ["unit"] }, () => {
	it("appended record has hash and redacted payload", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const { InProcessNerve } = await import("../../kernel/src/buses.js");
		const { SessionLog } = await import("../src/event-log-organ.js");
		const { SessionStore } = await import("../src/session-store.js");

		const cwd = mkdtempSync(join(tmpdir(), "alef-audit-"));
		try {
			const store = await SessionStore.create(cwd);
			const organ = new SessionLog(store);
			const nerve = new InProcessNerve();
			organ.mount(nerve.asNerve());

			// Publish event with sensitive payload
			nerve.asNerve().motor.publish({
				type: "test.event",
				payload: { command: "echo hi", apiKey: "super-secret", path: "/tmp" },
				correlationId: "c-1",
			});

			// Give fire-and-forget a moment to settle
			await new Promise((r) => setTimeout(r, 50));

			const events = await store.events();
			expect(events.length).toBeGreaterThan(0);

			// Motor bus event has the full redacted payload; sense has the dead-letter {}.
			const record = events.find((e) => e.type === "test.event" && e.bus === "motor");
			expect(record).toBeDefined();

			// Hash is present
			expect(record!.hash).toMatch(/^[0-9a-f]{64}$/);

			// apiKey is redacted
			expect(record!.payload.apiKey).toBe("[REDACTED]");

			// Non-sensitive fields preserved
			expect(record!.payload.command).toBe("echo hi");
			expect(record!.payload.path).toBe("/tmp");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
