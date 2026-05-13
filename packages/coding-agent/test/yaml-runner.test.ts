import { beforeEach, describe, expect, it, vi } from "vitest";

const { mainMock } = vi.hoisted(() => ({
	mainMock: vi.fn(async () => {}),
}));

vi.mock("../src/main.js", () => ({
	main: mainMock,
}));

import { runYamlRunner } from "../src/yaml-runner.js";

describe("runYamlRunner", () => {
	beforeEach(() => {
		mainMock.mockReset();
	});

	it("requires --blueprint", async () => {
		await expect(runYamlRunner(["--model", "openai/gpt-4.1"])).rejects.toThrow(
			"runYamlRunner requires --blueprint <path>.",
		);
		expect(mainMock).not.toHaveBeenCalled();
	});

	it("rejects rpc mode", async () => {
		await expect(runYamlRunner(["--blueprint", "./agent.yaml", "--mode", "rpc"])).rejects.toThrow(
			"runYamlRunner does not support --mode rpc.",
		);
		expect(mainMock).not.toHaveBeenCalled();
	});

	it("defaults to print mode when no mode is given", async () => {
		const args = ["--blueprint", "./agent.yaml", "ship it"];
		await runYamlRunner(args);
		expect(mainMock).toHaveBeenCalledTimes(1);
		expect(mainMock).toHaveBeenCalledWith(["--print", ...args], undefined);
	});

	it("preserves explicit print mode", async () => {
		const args = ["--blueprint", "./agent.yaml", "--print", "ship it"];
		await runYamlRunner(args);
		expect(mainMock).toHaveBeenCalledTimes(1);
		expect(mainMock).toHaveBeenCalledWith(args, undefined);
	});
});
