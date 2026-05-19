/**
 * ReactorOrgan tests — deterministic, no LLM, no real bus.
 *
 * Tests the in-flight tracking and prepareStep injection behaviour.
 */

import { InProcessNerve, newCorrelationId } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { createReactorOrgan } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function publishMotor(
	nerve: InProcessNerve,
	type: string,
	payload: Record<string, unknown>,
	correlationId = newCorrelationId(),
) {
	nerve.publishMotor({ type, payload, correlationId });
	return correlationId;
}

function publishSense(nerve: InProcessNerve, type: string, payload: Record<string, unknown>, correlationId: string) {
	nerve.asNerve().sense.publish({ type, payload, correlationId, isError: false });
}

type Msg = { role: string; content: string };

function sysMsg(content = "You are a helpful assistant."): Msg {
	return { role: "system", content };
}

function userMsg(content: string): Msg {
	return { role: "user", content };
}

// ---------------------------------------------------------------------------
// In-flight tracking
// ---------------------------------------------------------------------------

describe("ReactorOrgan — in-flight tracking", () => {
	it("records a motor event when no matching sense has arrived", async () => {
		const nerve = new InProcessNerve();
		const reactor = createReactorOrgan();
		reactor.mount(nerve.asNerve());

		const corr = publishMotor(nerve, "shell.exec", { command: "npm test", toolCallId: "tc-1" });

		await Promise.resolve();
		const inflight = reactor.inflight();
		expect(inflight.size).toBe(1);
		expect([...inflight.values()][0]).toMatchObject({ type: "shell.exec", correlationId: corr });
	});

	it("removes the entry when matching sense arrives", async () => {
		const nerve = new InProcessNerve();
		const reactor = createReactorOrgan();
		reactor.mount(nerve.asNerve());

		const corr = newCorrelationId();
		publishMotor(nerve, "shell.exec", { command: "npm test", toolCallId: "tc-1" }, corr);
		await Promise.resolve();
		expect(reactor.inflight().size).toBe(1);

		publishSense(nerve, "shell.exec", { output: "ok", exitCode: 0, isFinal: true, toolCallId: "tc-1" }, corr);
		await Promise.resolve();
		expect(reactor.inflight().size).toBe(0);
	});

	it("does not track motor/dialog.message — that is a reply, not a tool call", async () => {
		const nerve = new InProcessNerve();
		const reactor = createReactorOrgan();
		reactor.mount(nerve.asNerve());

		publishMotor(nerve, "dialog.message", { text: "I am done.", toolCallId: "tc-1" });
		await Promise.resolve();
		expect(reactor.inflight().size).toBe(0);
	});

	it("tracks multiple tool calls across different correlationIds", async () => {
		const nerve = new InProcessNerve();
		const reactor = createReactorOrgan();
		reactor.mount(nerve.asNerve());

		publishMotor(nerve, "shell.exec", { command: "npm test", toolCallId: "tc-1" }, "corr-A");
		publishMotor(nerve, "fs.write", { path: "src/main.ts", toolCallId: "tc-2" }, "corr-B");
		await Promise.resolve();

		expect(reactor.inflight().size).toBe(2);
	});

	it("resolving one entry does not affect others", async () => {
		const nerve = new InProcessNerve();
		const reactor = createReactorOrgan();
		reactor.mount(nerve.asNerve());

		publishMotor(nerve, "shell.exec", { command: "npm test", toolCallId: "tc-1" }, "corr-A");
		publishMotor(nerve, "fs.write", { path: "src/main.ts", toolCallId: "tc-2" }, "corr-B");
		await Promise.resolve();

		publishSense(nerve, "shell.exec", { output: "ok", exitCode: 0, isFinal: true, toolCallId: "tc-1" }, "corr-A");
		await Promise.resolve();

		expect(reactor.inflight().size).toBe(1);
		const remaining = [...reactor.inflight().values()][0];
		expect(remaining.type).toBe("fs.write");
	});

	it("cleans up subscriptions on unmount", async () => {
		const nerve = new InProcessNerve();
		const reactor = createReactorOrgan();
		const unmount = reactor.mount(nerve.asNerve());

		unmount();
		publishMotor(nerve, "shell.exec", { command: "npm test", toolCallId: "tc-1" });
		await Promise.resolve();

		expect(reactor.inflight().size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// prepareStep injection
// ---------------------------------------------------------------------------

describe("ReactorOrgan — prepareStep", () => {
	it("returns messages unchanged when nothing is in-flight", async () => {
		const nerve = new InProcessNerve();
		const reactor = createReactorOrgan();
		reactor.mount(nerve.asNerve());

		const messages = [sysMsg(), userMsg("hello")];
		const result = await reactor.prepareStep(messages);
		expect(result).toBe(messages);
	});

	it("appends pending block to system message when in-flight entries exist", async () => {
		const nerve = new InProcessNerve();
		const reactor = createReactorOrgan();
		reactor.mount(nerve.asNerve());

		publishMotor(nerve, "shell.exec", { command: "npm test", toolCallId: "tc-1" }, "corr-A");
		await Promise.resolve();

		const messages = [sysMsg("You are helpful."), userMsg("What is happening?")];
		const result = await reactor.prepareStep(messages);

		expect(result).not.toBe(messages); // new array
		const sys = result[0] as Msg;
		expect(sys.role).toBe("system");
		expect(sys.content).toContain("Pending operations");
		expect(sys.content).toContain("shell.exec");
	});

	it("includes elapsed time in pending block", async () => {
		const nerve = new InProcessNerve();
		const reactor = createReactorOrgan();
		reactor.mount(nerve.asNerve());

		publishMotor(nerve, "shell.exec", { command: "npm test", toolCallId: "tc-1" }, "corr-A");
		await new Promise((r) => setTimeout(r, 50)); // let time pass

		const result = await reactor.prepareStep([sysMsg(), userMsg("?")]);
		const sys = result[0] as Msg;
		// elapsed is shown in seconds — at least 0s
		expect(sys.content).toMatch(/\d+s/);
	});

	it("includes the key arg (command for shell.exec, path for fs.*) in the pending block", async () => {
		const nerve = new InProcessNerve();
		const reactor = createReactorOrgan();
		reactor.mount(nerve.asNerve());

		publishMotor(nerve, "shell.exec", { command: "docker build .", toolCallId: "tc-1" }, "corr-A");
		await Promise.resolve();

		const result = await reactor.prepareStep([sysMsg(), userMsg("?")]);
		const sys = result[0] as Msg;
		expect(sys.content).toContain("docker build .");
	});

	it("does not inject after in-flight entry is resolved", async () => {
		const nerve = new InProcessNerve();
		const reactor = createReactorOrgan();
		reactor.mount(nerve.asNerve());

		const corr = newCorrelationId();
		publishMotor(nerve, "shell.exec", { command: "npm test", toolCallId: "tc-1" }, corr);
		await Promise.resolve();
		publishSense(nerve, "shell.exec", { output: "ok", exitCode: 0, isFinal: true, toolCallId: "tc-1" }, corr);
		await Promise.resolve();

		const messages = [sysMsg(), userMsg("?")];
		const result = await reactor.prepareStep(messages);
		expect(result).toBe(messages);
	});

	it("handles missing system message gracefully — prepends one", async () => {
		const nerve = new InProcessNerve();
		const reactor = createReactorOrgan();
		reactor.mount(nerve.asNerve());

		publishMotor(nerve, "shell.exec", { command: "npm test", toolCallId: "tc-1" });
		await Promise.resolve();

		const messages = [userMsg("hello")];
		const result = await reactor.prepareStep(messages);
		// First message is now a system message with the pending block
		expect(result[0]).toMatchObject({ role: "system" });
		expect((result[0] as Msg).content).toContain("Pending operations");
		expect(result[1]).toMatchObject({ role: "user", content: "hello" });
	});
});
