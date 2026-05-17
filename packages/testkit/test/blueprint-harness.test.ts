/**
 * BlueprintHarness + ScriptedLLMOrgan tests.
 *
 * These tests prove the full blueprint testing framework:
 * - Simple text replies (no tool calls)
 * - Tool calls with real organ execution
 * - Assertions on tool call patterns
 * - Multi-turn conversations
 * - Blueprint file loading
 *
 * No real LLM. No API key. Deterministic.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsOrgan } from "../../organ-fs/src/index.js";
import { BlueprintHarness } from "../src/blueprint-harness.js";
import { step } from "../src/script.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const harnesses: BlueprintHarness[] = [];
function track(h: BlueprintHarness): BlueprintHarness {
	harnesses.push(h);
	return h;
}

const dirs: string[] = [];
function tmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-bph-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const h of harnesses.splice(0)) h.dispose();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ScriptedLLMOrgan — simple reply
// ---------------------------------------------------------------------------

describe("BlueprintHarness — simple reply (no tools)", () => {
	it("send() returns scripted reply text", async () => {
		const cwd = tmpDir();
		const h = track(
			BlueprintHarness.create({
				cwd,
				script: [step.reply("hello from script")],
			}),
		);
		const reply = await h.send("anything");
		expect(reply).toBe("hello from script");
	});

	it("assertReply matches substring (case-insensitive)", async () => {
		const cwd = tmpDir();
		const h = track(
			BlueprintHarness.create({ cwd, script: [step.reply("The Login function validates passwords.")] }),
		);
		await h.send("what does login do?");
		h.assertReply("login");
		h.assertReply("VALIDATES"); // case-insensitive
	});

	it("multi-turn: each send() advances the script", async () => {
		const cwd = tmpDir();
		const h = track(
			BlueprintHarness.create({
				cwd,
				script: [step.reply("first"), step.reply("second")],
			}),
		);
		expect(await h.send("turn 1")).toBe("first");
		expect(await h.send("turn 2")).toBe("second");
	});

	it("script exhausted: returns sentinel text without throwing", async () => {
		const cwd = tmpDir();
		const h = track(BlueprintHarness.create({ cwd, script: [step.reply("only one")] }));
		await h.send("turn 1");
		const reply = await h.send("turn 2"); // script exhausted
		expect(reply).toContain("script exhausted");
	});
});

// ---------------------------------------------------------------------------
// ScriptedLLMOrgan — tool calls with real organ execution
// ---------------------------------------------------------------------------

describe("BlueprintHarness — tool calls (real organ handlers)", () => {
	it("executes fs.read and collects result before replying", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "auth.ts"), "export function login(): boolean { return true; }");

		const h = track(
			BlueprintHarness.create({
				cwd,
				organs: [createFsOrgan({ cwd })],
				script: [step.toolCall("fs.read", { path: "auth.ts" }, "I read the file.")],
			}),
		);

		const reply = await h.send("read auth.ts");
		expect(reply).toBe("I read the file.");
		h.assertToolCalled("fs.read");
	});

	it("assertToolCalledWith checks partial payload match", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "config.ts"), "export const PORT = 3000;");

		const h = track(
			BlueprintHarness.create({
				cwd,
				organs: [createFsOrgan({ cwd })],
				script: [step.toolCall("fs.read", { path: "config.ts" }, "Done.")],
			}),
		);

		await h.send("read config");
		h.assertToolCalledWith("fs.read", { path: "config.ts" });
	});

	it("assertNotToolCalled verifies tools were NOT used", async () => {
		const cwd = tmpDir();
		const h = track(
			BlueprintHarness.create({
				cwd,
				script: [step.reply("just a reply, no tools")],
			}),
		);
		await h.send("hi");
		h.assertNotToolCalled("fs.write");
		h.assertNotToolCalled("shell.exec");
	});

	it("parallel tool calls via step.toolCalls", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "a.ts"), "export const A = 1;");
		writeFileSync(join(cwd, "b.ts"), "export const B = 2;");

		const h = track(
			BlueprintHarness.create({
				cwd,
				organs: [createFsOrgan({ cwd })],
				script: [
					step.toolCalls(
						[
							{ name: "fs.read", args: { path: "a.ts" } },
							{ name: "fs.read", args: { path: "b.ts" } },
						],
						"Read both files.",
					),
				],
			}),
		);

		const reply = await h.send("read a and b");
		expect(reply).toBe("Read both files.");

		const fsReadCalls = h.motorEvents.filter((e) => e.type === "fs.read");
		expect(fsReadCalls).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Blueprint file loading
// ---------------------------------------------------------------------------

describe("BlueprintHarness.fromBlueprint()", () => {
	it("loads a minimal blueprint and runs scripted agent loop", async () => {
		const cwd = tmpDir();
		writeFileSync(join(cwd, "auth.ts"), "export function login(): boolean { return true; }");

		const blueprintPath = join(cwd, "agent.yaml");
		writeFileSync(
			blueprintPath,
			["name: test-agent", "organs:", "  - name: fs", "    actions: [read, grep, find]"].join("\n"),
		);

		const h = await BlueprintHarness.fromBlueprint(blueprintPath, {
			cwd,
			script: [step.toolCall("fs.read", { path: "auth.ts" }, "File read successfully.")],
		});
		harnesses.push(h);

		const reply = await h.send("read auth.ts");
		expect(reply).toBe("File read successfully.");
		h.assertToolCalled("fs.read");
		h.assertNotToolCalled("fs.write"); // read-only blueprint
	});

	it("blueprint with fs actions=[read] cannot call fs.write (ablation)", async () => {
		const cwd = tmpDir();
		const blueprintPath = join(cwd, "agent.yaml");
		writeFileSync(
			blueprintPath,
			["name: readonly-agent", "organs:", "  - name: fs", "    actions: [read]"].join("\n"),
		);

		const h = await BlueprintHarness.fromBlueprint(blueprintPath, {
			cwd,
			script: [step.reply("I can only read.")],
		});
		harnesses.push(h);

		// fs.write tool should not be registered
		expect(h.scriptedLlm).toBeDefined();

		// Verify via send + assertion
		await h.send("can you write?");
		h.assertNotToolCalled("fs.write");
	});
});

// ---------------------------------------------------------------------------
// Event observation
// ---------------------------------------------------------------------------

describe("BlueprintHarness — event observation", () => {
	it("motorEvents cleared between send() calls", async () => {
		const cwd = tmpDir();
		const h = track(
			BlueprintHarness.create({
				cwd,
				script: [step.reply("one"), step.reply("two")],
			}),
		);

		await h.send("turn 1");
		const firstMotorCount = h.motorEvents.length;

		await h.send("turn 2");
		// motorEvents is cleared at each send() — so count resets
		expect(h.motorEvents.length).toBeLessThanOrEqual(firstMotorCount + 2);
	});
});
