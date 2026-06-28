import type { Session } from "@dpopsuev/alef-session/contracts";
import { describe, expect, it, vi } from "vitest";
import { runInteractive } from "../src/client/interactive.js";
import { readStdinLines } from "../src/client/stdin.js";

vi.mock("../src/client/stdin.js", () => ({
	readStdinLines: vi.fn(),
}));

const mockedReadStdinLines = vi.mocked(readStdinLines);

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

const OPTS = { cwd: "/tmp", modelId: "claude-haiku-4-5", sessionId: "test-session" };

describe("runInteractive", { tags: ["unit"] }, () => {
	it("sends each line via session.send", async () => {
		mockedReadStdinLines.mockReturnValue(
			(async function* () {
				yield "line one";
				yield "line two";
			})(),
		);
		const session = makeSession();
		await runInteractive(session, OPTS);
		expect(session.send).toHaveBeenCalledTimes(2);
		expect(session.send).toHaveBeenNthCalledWith(1, "line one", 120_000);
		expect(session.send).toHaveBeenNthCalledWith(2, "line two", 120_000);
	});

	it("stops on /exit command without sending it", async () => {
		mockedReadStdinLines.mockReturnValue(
			(async function* () {
				yield "hello";
				yield "/exit";
				yield "this should not be sent";
			})(),
		);
		const session = makeSession();
		await runInteractive(session, OPTS);
		expect(session.send).toHaveBeenCalledOnce();
	});

	it("calls session.dispose after the loop ends normally", async () => {
		mockedReadStdinLines.mockReturnValue(
			(async function* () {
				yield "one message";
			})(),
		);
		const session = makeSession();
		await runInteractive(session, OPTS);
		expect(session.dispose).toHaveBeenCalledOnce();
	});

	it("continues loop on error and disposes cleanly", async () => {
		mockedReadStdinLines.mockReturnValue(
			(async function* () {
				yield "trigger error";
				yield "this still sends";
			})(),
		);
		let callCount = 0;
		const session = makeSession();
		(session.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) throw new Error("LLM unavailable");
			return "ok";
		});
		await runInteractive(session, OPTS);
		expect(session.send).toHaveBeenCalledTimes(2);
		expect(session.dispose).toHaveBeenCalledOnce();
	});

	it("handles empty input (no lines) without sending anything", async () => {
		mockedReadStdinLines.mockReturnValue((async function* () {})());
		const session = makeSession();
		await runInteractive(session, OPTS);
		expect(session.send).not.toHaveBeenCalled();
		expect(session.dispose).toHaveBeenCalledOnce();
	});
});
