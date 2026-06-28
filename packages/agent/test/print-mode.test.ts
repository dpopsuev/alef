import type { Session } from "@dpopsuev/alef-session/contracts";
import { describe, expect, it, vi } from "vitest";
import { runPrintMode } from "../src/cli/print-mode.js";

function makeSession(reply = "mock reply"): Session {
	return {
		state: { id: "test", modelId: "test-model", contextWindow: 128_000 },
		getModel: vi.fn(() => "test-model"),
		setModel: vi.fn(),
		getThinking: vi.fn(() => "off"),
		setThinking: vi.fn(),
		setTurnController: vi.fn(),
		dispose: vi.fn(),
		send: vi.fn().mockResolvedValue(reply),
		subscribe: vi.fn(() => () => {}),
	};
}

describe("runPrintMode", { tags: ["unit"] }, () => {
	it("calls session.send with the prompt", async () => {
		const session = makeSession();
		await runPrintMode("hello", session);
		expect(session.send).toHaveBeenCalledOnce();
		expect(session.send).toHaveBeenCalledWith("hello", 120_000);
	});

	it("calls session.dispose after send resolves", async () => {
		const session = makeSession();
		await runPrintMode("hi", session);
		expect(session.dispose).toHaveBeenCalledOnce();
	});

	it("calls dispose and sets exitCode=1 when send rejects", async () => {
		const session = makeSession();
		(session.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("LLM error"));
		const originalExitCode = process.exitCode;
		await runPrintMode("hi", session);
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(process.exitCode).toBe(1);
		process.exitCode = originalExitCode;
	});
});
