import { describe, expect, it, vi } from "vitest";
import { runPrintMode } from "../src/print-mode.js";

function makeDialog(reply = "mock reply") {
	return {
		send: vi.fn().mockResolvedValue(reply),
	};
}

describe("runPrintMode", () => {
	it("calls dialog.send with the prompt", async () => {
		const dialog = makeDialog();
		const dispose = vi.fn();

		await runPrintMode("hello", dialog as never, dispose);

		expect(dialog.send).toHaveBeenCalledOnce();
		expect(dialog.send).toHaveBeenCalledWith("hello", "human", 120_000);
	});

	it("calls dispose after send resolves", async () => {
		const dialog = makeDialog();
		const dispose = vi.fn();

		await runPrintMode("hi", dialog as never, dispose);

		expect(dispose).toHaveBeenCalledOnce();
	});

	it("calls dispose and sets exitCode=1 when send rejects", async () => {
		const dialog = {
			send: vi.fn().mockRejectedValue(new Error("LLM error")),
		};
		const dispose = vi.fn();
		const originalExitCode = process.exitCode;

		await runPrintMode("hi", dialog as never, dispose); // does NOT throw now

		expect(dispose).toHaveBeenCalledOnce();
		expect(process.exitCode).toBe(1);
		process.exitCode = originalExitCode; // restore
	});
});
