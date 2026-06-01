import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { ScriptedReasoner, step } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { SessionGuard } from "../src/session-guard.js";

const disposes: Array<() => void> = [];
afterEach(() => {
	for (const d of disposes.splice(0)) d();
});

function makeSetup(maxTurns: number, script: ConstructorParameters<typeof ScriptedReasoner>[0]) {
	const agent = new Agent();
	const dialog = new DialogOrgan({ sink: () => {} });
	const llm = new ScriptedReasoner(script);
	agent.load(dialog).load(llm);
	agent.validate();
	disposes.push(() => agent.dispose());
	return { guard: new SessionGuard(dialog, maxTurns), dialog };
}

describe("SessionGuard", () => {
	it("allows sends up to maxTurns", async () => {
		const { guard } = makeSetup(2, [step.reply("one"), step.reply("two")]);
		expect(await guard.send("first")).toBe("one");
		expect(await guard.send("second")).toBe("two");
	});

	it("rejects sends beyond maxTurns", async () => {
		const { guard } = makeSetup(1, [step.reply("only one")]);
		await guard.send("turn 1");
		await expect(guard.send("turn 2")).rejects.toThrow(/max turns/i);
	});

	it("maxTurns 0 means unlimited", async () => {
		const { guard } = makeSetup(0, [step.reply("a"), step.reply("b"), step.reply("c")]);
		expect(await guard.send("1")).toBe("a");
		expect(await guard.send("2")).toBe("b");
		expect(await guard.send("3")).toBe("c");
	});
});
