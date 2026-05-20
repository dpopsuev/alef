import type { SenseEvent } from "@dpopsuev/alef-spine";
import { InProcessNerve } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { createNodeshOrgan } from "../src/organ.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve };
}

function publishMotor(
	nerve: InProcessNerve,
	type: string,
	payload: Record<string, unknown>,
	correlationId = "test-corr",
) {
	nerve.publishMotor({ type, payload, correlationId });
}

function waitForSense(nerve: InProcessNerve, type: string): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const unsub = nerve.asNerve().sense.subscribe(type, (event) => {
			unsub();
			resolve(event);
		});
	});
}

describe("NodeshOrgan — organ metadata", () => {
	it("has name=nodesh and 1 tool", () => {
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		expect(organ.name).toBe("nodesh");
		expect(organ.tools).toHaveLength(1);
		expect(organ.tools[0].name).toBe("nodesh.eval");
	});

	it("unmount unsubscribes motor handler", () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());
		expect(nerve.listenerCount("motor", "nodesh.eval")).toBe(1);
		unmount();
		expect(nerve.listenerCount("motor", "nodesh.eval")).toBe(0);
	});
});

describe("NodeshOrgan — expression evaluation", () => {
	it("evaluates a simple arithmetic expression", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", { code: "1 + 2 + 3" });
		const result = await p;

		expect(result.isError).toBe(false);
		expect((result.payload as { result: unknown }).result).toBe(6);
		unmount();
	});

	it("evaluates object literals and returns structured result", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", { code: "({ name: 'alef', version: 1 })" });
		const result = await p;

		expect(result.isError).toBe(false);
		const r = result.payload as { result: { name: string; version: number } };
		expect(r.result.name).toBe("alef");
		expect(r.result.version).toBe(1);
		unmount();
	});

	it("explicit result = ... assignment wins over expression return", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", { code: "result = 42; 'ignored'" });
		const result = await p;

		expect((result.payload as { result: unknown }).result).toBe(42);
		unmount();
	});

	it("captures console.log output in stdout field", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", { code: "console.log('hello'); console.log('world'); 'done'" });
		const result = await p;

		expect(result.isError).toBe(false);
		const payload = result.payload as { stdout: string };
		expect(payload.stdout).toContain("hello");
		expect(payload.stdout).toContain("world");
		unmount();
	});

	it("supports top-level await", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", {
			code: "await Promise.resolve(); result = 'async ok'",
		});
		const result = await p;

		expect(result.isError).toBe(false);
		expect((result.payload as { result: unknown }).result).toBe("async ok");
		unmount();
	});
});

describe("NodeshOrgan — prelude", () => {
	it("prelude bindings are available in eval", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({
			cwd: process.cwd(),
			prelude: "const GREETING = 'hello from prelude';",
		});
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", { code: "GREETING" });
		const result = await p;

		expect((result.payload as { result: unknown }).result).toBe("hello from prelude");
		unmount();
	});
});

describe("NodeshOrgan — security", () => {
	it("blocks require of child_process", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", { code: "require('child_process')" });
		const result = await p;

		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/allowlist/i);
		unmount();
	});

	it("allows require of allowed modules (node:path)", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", {
			code: "const p = require('path'); typeof p.join",
		});
		const result = await p;

		expect(result.isError).toBe(false);
		expect((result.payload as { result: unknown }).result).toBe("function");
		unmount();
	});

	it("each call gets a fresh context — no state leak between calls", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		// First call sets a variable.
		const p1 = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", { code: "var SECRET = 42; SECRET" }, "corr-1");
		await p1;

		// Second call — SECRET must not exist.
		const p2 = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", { code: "typeof SECRET" }, "corr-2");
		const r2 = await p2;

		expect((r2.payload as { result: unknown }).result).toBe("undefined");
		unmount();
	});

	it("timeout fires on infinite loop", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd(), defaultTimeoutSeconds: 1 });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", { code: "while(true){}" });
		const result = await p;

		expect(result.isError).toBe(true);
		unmount();
	}, 5_000);
});

describe("NodeshOrgan — error handling", () => {
	it("publishes error sense on syntax error", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", { code: "{{{{ invalid syntax" });
		const result = await p;

		expect(result.isError).toBe(true);
		unmount();
	});

	it("publishes error sense on runtime error", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", { code: "null.property" });
		const result = await p;

		expect(result.isError).toBe(true);
		unmount();
	});

	it("mirrors correlationId from motor event", async () => {
		const { nerve } = makeNerve();
		const organ = createNodeshOrgan({ cwd: process.cwd() });
		const unmount = organ.mount(nerve.asNerve());

		const p = waitForSense(nerve, "nodesh.eval");
		publishMotor(nerve, "nodesh.eval", { code: "1" }, "my-corr-id");
		const result = await p;

		expect(result.correlationId).toBe("my-corr-id");
		unmount();
	});
});
