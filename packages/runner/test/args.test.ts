import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
	it("defaults to interactive mode with process.cwd()", () => {
		const args = parseArgs([]);
		expect(args.print).toBe(false);
		expect(args.prompt).toBe("");
		expect(args.cwd).toBe(process.cwd());
	});

	it("-p sets print mode with prompt", () => {
		const args = parseArgs(["-p", "hello world"]);
		expect(args.print).toBe(true);
		expect(args.prompt).toBe("hello world");
	});

	it("--print sets print mode with prompt", () => {
		const args = parseArgs(["--print", "hello world"]);
		expect(args.print).toBe(true);
		expect(args.prompt).toBe("hello world");
	});

	it("bare positional argument sets print mode", () => {
		const args = parseArgs(["what is 2+2?"]);
		expect(args.print).toBe(true);
		expect(args.prompt).toBe("what is 2+2?");
	});

	it("--cwd sets working directory", () => {
		const args = parseArgs(["--cwd", "/tmp/project"]);
		expect(args.cwd).toBe("/tmp/project");
	});

	it("--model sets model ID", () => {
		const args = parseArgs(["--model", "claude-haiku-4-5"]);
		expect(args.modelId).toBe("claude-haiku-4-5");
	});

	it("combines --cwd and -p", () => {
		const args = parseArgs(["--cwd", "/tmp", "-p", "audit src/"]);
		expect(args.cwd).toBe("/tmp");
		expect(args.print).toBe(true);
		expect(args.prompt).toBe("audit src/");
	});

	it("ALEF_MODEL env var sets default model", () => {
		const original = process.env.ALEF_MODEL;
		process.env.ALEF_MODEL = "claude-opus-4-5";
		const args = parseArgs([]);
		process.env.ALEF_MODEL = original;
		expect(args.modelId).toBe("claude-opus-4-5");
	});

	it("--model overrides ALEF_MODEL env var", () => {
		const original = process.env.ALEF_MODEL;
		process.env.ALEF_MODEL = "claude-opus-4-5";
		const args = parseArgs(["--model", "claude-haiku-4-5"]);
		process.env.ALEF_MODEL = original;
		expect(args.modelId).toBe("claude-haiku-4-5");
	});
});
