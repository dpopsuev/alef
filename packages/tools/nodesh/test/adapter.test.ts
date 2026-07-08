import { adapterComplianceSuite, BusFixture } from "@dpopsuev/alef-testkit/organ";
import { describe, expect, it } from "vitest";
import { createNodeshAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createNodeshAdapter({ cwd: "/tmp" }));

function fixture(opts: { prelude?: string; defaultTimeoutSeconds?: number } = {}) {
	const f = new BusFixture();
	f.mount(createNodeshAdapter({ cwd: process.cwd(), ...opts }));
	return f;
}

describe("NodeshOrgan — organ metadata", { tags: ["compliance"] }, () => {
	it("has name=nodesh and 1 tool", () => {
		const organ = createNodeshAdapter({ cwd: process.cwd() });
		expect(organ.name).toBe("nodesh");
		expect(organ.tools).toHaveLength(1);
		expect(organ.tools[0]!.name).toBe("nodesh.eval");
	});

	it("unmount unsubscribes motor handler", () => {
		const f = new BusFixture();
		const organ = createNodeshAdapter({ cwd: process.cwd() });
		const unmount = f.mount(organ);
		expect(f.bus.listenerCount("command", "nodesh.eval")).toBe(1);
		unmount();
		expect(f.bus.listenerCount("command", "nodesh.eval")).toBe(0);
	});
});

describe("NodeshOrgan — expression evaluation", { tags: ["compliance"] }, () => {
	it("evaluates a simple arithmetic expression", async () => {
		const f = fixture();
		const result = await f.call("nodesh.eval", { code: "1 + 2 + 3" });
		expect(result.isError).toBe(false);
		expect((result.payload as { result: unknown }).result).toBe(6);
		f.dispose();
	});

	it("evaluates object literals and returns structured result", async () => {
		const f = fixture();
		const result = await f.call("nodesh.eval", { code: "({ name: 'alef', version: 1 })" });
		expect(result.isError).toBe(false);
		const r = result.payload as { result: { name: string; version: number } };
		expect(r.result.name).toBe("alef");
		expect(r.result.version).toBe(1);
		f.dispose();
	});

	it("explicit result = ... assignment wins over expression return", async () => {
		const f = fixture();
		const result = await f.call("nodesh.eval", { code: "result = 42; 'ignored'" });
		expect((result.payload as { result: unknown }).result).toBe(42);
		f.dispose();
	});

	it("captures console.log output in stdout field", async () => {
		const f = fixture();
		const result = await f.call("nodesh.eval", { code: "console.log('hello'); console.log('world'); 'done'" });
		expect(result.isError).toBe(false);
		const payload = result.payload as { stdout: string };
		expect(payload.stdout).toContain("hello");
		expect(payload.stdout).toContain("world");
		f.dispose();
	});

	it("supports top-level await", async () => {
		const f = fixture();
		const result = await f.call("nodesh.eval", { code: "await Promise.resolve(); result = 'async ok'" });
		expect(result.isError).toBe(false);
		expect((result.payload as { result: unknown }).result).toBe("async ok");
		f.dispose();
	});
});

describe("NodeshOrgan — prelude", { tags: ["compliance"] }, () => {
	it("prelude bindings are available in eval", async () => {
		const f = fixture({ prelude: "const GREETING = 'hello from prelude';" });
		const result = await f.call("nodesh.eval", { code: "GREETING" });
		expect((result.payload as { result: unknown }).result).toBe("hello from prelude");
		f.dispose();
	});
});

describe("NodeshOrgan — security", { tags: ["compliance"] }, () => {
	it("blocks require of child_process", async () => {
		const f = fixture();
		const result = await f.call("nodesh.eval", { code: "require('child_process')" });
		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/allowlist/i);
		f.dispose();
	});

	it("allows require of allowed modules (node:path)", async () => {
		const f = fixture();
		const result = await f.call("nodesh.eval", { code: "const p = require('path'); typeof p.join" });
		expect(result.isError).toBe(false);
		expect((result.payload as { result: unknown }).result).toBe("function");
		f.dispose();
	});

	it("each call gets a fresh context — no state leak between calls", async () => {
		const f = fixture();
		await f.call("nodesh.eval", { code: "var SECRET = 42; SECRET" });
		const r2 = await f.call("nodesh.eval", { code: "typeof SECRET" });
		expect((r2.payload as { result: unknown }).result).toBe("undefined");
		f.dispose();
	});

	it("timeout fires on infinite loop", async () => {
		const f = fixture({ defaultTimeoutSeconds: 1 });
		const result = await f.call("nodesh.eval", { code: "while(true){}" }, { timeoutMs: 5_000 });
		expect(result.isError).toBe(true);
		f.dispose();
	}, 5_000);
});

describe("NodeshOrgan — error handling", { tags: ["compliance"] }, () => {
	it("publishes error sense on syntax error", async () => {
		const f = fixture();
		const result = await f.call("nodesh.eval", { code: "{{{{ invalid syntax" });
		expect(result.isError).toBe(true);
		f.dispose();
	});

	it("publishes error sense on runtime error", async () => {
		const f = fixture();
		const result = await f.call("nodesh.eval", { code: "null.property" });
		expect(result.isError).toBe(true);
		f.dispose();
	});

	it("mirrors correlationId from motor event", async () => {
		const f = fixture();
		const result = await f.call("nodesh.eval", { code: "1" }, { correlationId: "my-corr-id" });
		expect(result.correlationId).toBe("my-corr-id");
		f.dispose();
	});
});
