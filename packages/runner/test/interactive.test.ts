import { describe, expect, it, vi } from "vitest";
import { runInteractive } from "../src/interactive.js";
import { readStdinLines } from "../src/stdin.js";

// Stub readStdinLines so we can control what lines the interactive loop receives
// without touching process.stdin.
vi.mock("../src/stdin.js", () => ({
	readStdinLines: vi.fn(),
}));

const mockedReadStdinLines = vi.mocked(readStdinLines);

function makeDialog(reply = "mock reply") {
	return {
		send: vi.fn().mockResolvedValue(reply),
	};
}

const OPTS = { cwd: "/tmp", modelId: "claude-haiku-4-5" };

describe("runInteractive", () => {
	it("sends each line to dialog.send", async () => {
		mockedReadStdinLines.mockReturnValue(
			(async function* () {
				yield "line one";
				yield "line two";
			})(),
		);
		const dialog = makeDialog();
		const dispose = vi.fn();

		await runInteractive(dialog as never, OPTS, dispose);

		expect(dialog.send).toHaveBeenCalledTimes(2);
		expect(dialog.send).toHaveBeenNthCalledWith(1, "line one");
		expect(dialog.send).toHaveBeenNthCalledWith(2, "line two");
	});

	it("stops on /exit command without sending it", async () => {
		mockedReadStdinLines.mockReturnValue(
			(async function* () {
				yield "hello";
				yield "/exit";
				yield "this should not be sent";
			})(),
		);
		const dialog = makeDialog();
		const dispose = vi.fn();

		await runInteractive(dialog as never, OPTS, dispose);

		expect(dialog.send).toHaveBeenCalledOnce();
		expect(dialog.send).toHaveBeenCalledWith("hello");
	});

	it("calls dispose after the loop ends normally", async () => {
		mockedReadStdinLines.mockReturnValue(
			(async function* () {
				yield "one message";
			})(),
		);
		const dispose = vi.fn();

		await runInteractive(makeDialog() as never, OPTS, dispose);

		expect(dispose).toHaveBeenCalledOnce();
	});

	it("calls dispose even when dialog.send rejects", async () => {
		mockedReadStdinLines.mockReturnValue(
			(async function* () {
				yield "trigger error";
			})(),
		);
		const dialog = {
			send: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
		};
		const dispose = vi.fn();

		await expect(runInteractive(dialog as never, OPTS, dispose)).rejects.toThrow("LLM unavailable");

		expect(dispose).toHaveBeenCalledOnce();
	});

	it("handles empty input (no lines) without sending anything", async () => {
		mockedReadStdinLines.mockReturnValue((async function* () {})());
		const dialog = makeDialog();
		const dispose = vi.fn();

		await runInteractive(dialog as never, OPTS, dispose);

		expect(dialog.send).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledOnce();
	});
});
