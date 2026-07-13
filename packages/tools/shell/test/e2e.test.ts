import { randomUUID } from "node:crypto";
import { createE2eSession, HAVE_REAL_LLM } from "@dpopsuev/alef-testkit";
import { describe, expect, it } from "vitest";
import { createShellAdapter } from "../src/adapter.js";

describe.skipIf(!HAVE_REAL_LLM)("shell — real LLM E2E", { tags: ["real-llm"] }, () => {
	it("LLM runs a shell command and reads its output", async () => {
		const uuid = randomUUID();
		const session = createE2eSession([createShellAdapter({ cwd: process.cwd() })]);

		const { reply, events } = await session.send(
			`Run the shell command: echo ${uuid} and tell me what it printed. You MUST use the shell.exec tool.`,
		);

		expect(reply).toContain(uuid);
		expect(events.some((e) => e.type === "llm.tool-start" && String(e.payload.name ?? "").includes("shell"))).toBe(
			true,
		);

		session.dispose();
	}, 60_000);
});
