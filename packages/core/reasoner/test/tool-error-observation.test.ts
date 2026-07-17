import { describe, expect, it } from "vitest";
import {
	classifyToolError,
	formatToolErrorObservation,
} from "../src/tool-error-observation.js";

describe("tool-error observation", { tags: ["unit"] }, () => {
	it("classifies timeout with retry recoverability", () => {
		const obs = classifyToolError("command timed out after 30s", { tool: "shell.exec" });
		expect(obs.type).toBe("tool_error");
		expect(obs.errorType).toBe("timeout");
		expect(obs.recoverability).toBe("retry");
		expect(obs.suggestedNextAct.toLowerCase()).toContain("timeout");
	});

	it("classifies permission errors as alternate_tool", () => {
		const obs = classifyToolError("path outside writable roots", { tool: "fs.write" });
		expect(obs.errorType).toBe("permission");
		expect(obs.recoverability).toBe("alternate_tool");
	});

	it("serializes to JSON for transcript injection", () => {
		const obs = classifyToolError("ENOENT: not found", { tool: "fs.read" });
		const text = formatToolErrorObservation(obs);
		expect(JSON.parse(text)).toMatchObject({
			type: "tool_error",
			errorType: "not_found",
			tool: "fs.read",
		});
	});
});
