import { describe, expect, it } from "vitest";
import { formatCommandFailure, getErrorMessage, getErrorOutput } from "../src/errors.js";

describe("getErrorOutput", { tags: ["unit"] }, () => {
	it("returns undefined for plain Error", () => {
		expect(getErrorOutput(new Error("exit code 1"))).toBeUndefined();
	});

	it("returns undefined for empty output", () => {
		expect(getErrorOutput(Object.assign(new Error("exit code 1"), { output: "" }))).toBeUndefined();
	});

	it("returns undefined for non-string output", () => {
		expect(getErrorOutput(Object.assign(new Error("x"), { output: 42 }))).toBeUndefined();
	});

	it("returns attached stdout/stderr", () => {
		expect(getErrorOutput(Object.assign(new Error("exit code 1"), { output: "tsc failed\n" }))).toBe(
			"tsc failed\n",
		);
	});
});

describe("formatCommandFailure", { tags: ["unit"] }, () => {
	it("plain Error → message only, empty payload", () => {
		const failure = formatCommandFailure(new Error("boom"));
		expect(failure.message).toBe("boom");
		expect(failure.payload).toEqual({});
	});

	it("string throw → message only", () => {
		expect(formatCommandFailure("raw").message).toBe("raw");
	});

	it("appends output even when it is a substring of the message", () => {
		const err = Object.assign(new Error("exit code 1"), { output: "1", exitCode: 1 });
		const failure = formatCommandFailure(err);
		expect(failure.message).toBe("exit code 1\n1");
		expect(failure.payload).toEqual({ output: "1", exitCode: 1 });
	});

	it("forwards exitCode without output", () => {
		const err = Object.assign(new Error("exit code 2"), { exitCode: 2 });
		const failure = formatCommandFailure(err);
		expect(failure.message).toBe("exit code 2");
		expect(failure.payload).toEqual({ exitCode: 2 });
	});

	it("preserves diagnostic text for shell-style failures", () => {
		const diagnostic = "error TS2339: Property 'input' does not exist";
		const err = Object.assign(new Error("exit code 1"), { exitCode: 1, output: `${diagnostic}\n` });
		const failure = formatCommandFailure(err);
		expect(failure.message).toContain(diagnostic);
		expect(failure.message.startsWith("exit code 1\n")).toBe(true);
		expect(failure.payload.output).toContain(diagnostic);
		expect(failure.payload.exitCode).toBe(1);
	});

	it("getErrorMessage stays message-only (no output append)", () => {
		const err = Object.assign(new Error("exit code 1"), { output: "diag" });
		expect(getErrorMessage(err)).toBe("exit code 1");
	});
});
