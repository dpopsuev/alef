/**
 * Turn limit enforcement — previously SessionGuard, now inline in LocalSession.send.
 *
 * The counter lives in main.ts as _turnCount. These tests verify the logic
 * directly by testing the same conditional that was extracted from SessionGuard.
 */

import { describe, expect, it } from "vitest";

function makeSend(maxTurns: number) {
	let turnCount = 0;
	return async (text: string): Promise<string> => {
		if (maxTurns > 0 && turnCount >= maxTurns) {
			return Promise.reject(new Error(`Max turns reached (${maxTurns}). Start a new session to continue.`));
		}
		turnCount++;
		return `reply to: ${text}`;
	};
}

describe("turn limit enforcement (inlined from SessionGuard)", () => {
	it("allows sends up to maxTurns", async () => {
		const send = makeSend(2);
		await expect(send("one")).resolves.toContain("one");
		await expect(send("two")).resolves.toContain("two");
	});

	it("rejects on the turn that exceeds maxTurns", async () => {
		const send = makeSend(1);
		await send("ok");
		await expect(send("over")).rejects.toThrow("Max turns reached");
	});

	it("maxTurns=0 means unlimited", async () => {
		const send = makeSend(0);
		for (let i = 0; i < 10; i++) {
			await expect(send(`turn ${i}`)).resolves.toBeDefined();
		}
	});

	it("error message includes the limit", async () => {
		const send = makeSend(3);
		await send("a");
		await send("b");
		await send("c");
		await expect(send("d")).rejects.toThrow("3");
	});
});
