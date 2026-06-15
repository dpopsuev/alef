/**
 * Verifier self-tests — always CI, no LLM gate.
 *
 * Each describe block proves that the corresponding verifier function from
 * e2e-verifiers.ts accepts a known-good fixture and rejects known-bad ones.
 *
 * If a test here fails: the verifier logic is broken (fix the verifier).
 * If a real-LLM test fails but the verifier self-test passes: agent behavior changed.
 *
 * Pattern mirrors pivi's verifierCheck approach.
 */

import { describe, expect, it } from "vitest";
import {
	assertFileReadWorkflow,
	assertHashesPresent,
	assertMultiTurnHistory,
	assertOrganSelection,
	assertSseFilter,
	assertSubagentWorkflow,
	assertToolSequence,
	assertWebFetch,
	type ToolRecord,
} from "./e2e-verifiers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rec(type: string, bus: "motor" | "sense" | "internal" = "motor", hash = "a".repeat(64)): ToolRecord {
	return { type, bus, hash };
}

// ---------------------------------------------------------------------------
// E2E-184: file read workflow
// ---------------------------------------------------------------------------

describe("verifier: assertFileReadWorkflow", { tags: ["unit"] }, () => {
	it("accepts fs.read + reply containing secret", () => {
		const records = [rec("llm.response", "sense"), rec("fs.read"), rec("fs.read", "sense"), rec("llm.response")];
		expect(() => assertFileReadWorkflow(records, "The secret is XYZ-123", "XYZ-123")).not.toThrow();
	});

	it("accepts lector.read as alternative to fs.read", () => {
		const records = [rec("lector.read"), rec("lector.read", "sense"), rec("llm.response")];
		expect(() => assertFileReadWorkflow(records, "token=ABC", "ABC")).not.toThrow();
	});

	it("rejects when no file read event present", () => {
		const records = [rec("llm.response", "sense"), rec("llm.response")];
		expect(() => assertFileReadWorkflow(records, "The secret is XYZ", "XYZ")).toThrow(/fs\.read or lector\.read/);
	});

	it("rejects when reply does not contain the secret", () => {
		const records = [rec("fs.read"), rec("llm.response")];
		expect(() => assertFileReadWorkflow(records, "I found something interesting", "XYZ-123")).toThrow(/secret/);
	});
});

describe("verifier: assertHashesPresent", { tags: ["unit"] }, () => {
	it("accepts records all with hashes", () => {
		const records = [rec("fs.read"), rec("llm.response", "motor", "b".repeat(64))];
		expect(() => assertHashesPresent(records)).not.toThrow();
	});

	it("skips internal records (they have no hash)", () => {
		const records = [rec("fs.read"), { type: "window.assembled", bus: "internal" as const }];
		expect(() => assertHashesPresent(records)).not.toThrow();
	});

	it("rejects non-internal records missing hash", () => {
		const records = [{ type: "fs.read", bus: "motor" as const }];
		expect(() => assertHashesPresent(records)).toThrow(/hash/);
	});
});

// ---------------------------------------------------------------------------
// E2E-185: blueprint organ selection
// ---------------------------------------------------------------------------

describe("verifier: assertOrganSelection", { tags: ["unit"] }, () => {
	it("accepts fs.read with no lector/shell events", () => {
		const records = [rec("fs.read"), rec("fs.read", "sense"), rec("llm.response")];
		expect(() => assertOrganSelection(records, ["fs.read"], ["lector.", "shell."])).not.toThrow();
	});

	it("rejects when required type is absent", () => {
		const records = [rec("llm.response")];
		expect(() => assertOrganSelection(records, ["fs.read"], [])).toThrow(/fs\.read/);
	});

	it("rejects when lector.* appears", () => {
		const records = [rec("fs.read"), rec("lector.read"), rec("llm.response")];
		expect(() => assertOrganSelection(records, ["fs.read"], ["lector.", "shell."])).toThrow(/lector/);
	});

	it("rejects when shell.* appears", () => {
		const records = [rec("fs.read"), rec("shell.exec"), rec("llm.response")];
		expect(() => assertOrganSelection(records, ["fs.read"], ["lector.", "shell."])).toThrow(/shell/);
	});
});

// ---------------------------------------------------------------------------
// E2E-187: SSE surface filter
// ---------------------------------------------------------------------------

describe("verifier: assertSseFilter", { tags: ["unit"] }, () => {
	it("accepts llm.response on SSE, fs.read absent from SSE but in JSONL", () => {
		const sseTypes = ["llm.response"];
		const jsonlTypes = new Set(["fs.read", "llm.response"]);
		expect(() => assertSseFilter(sseTypes, jsonlTypes, ["llm.response"], ["fs.read"])).not.toThrow();
	});

	it("rejects when required SSE event is absent", () => {
		const sseTypes: string[] = [];
		const jsonlTypes = new Set(["fs.read"]);
		expect(() => assertSseFilter(sseTypes, jsonlTypes, ["llm.response"], ["fs.read"])).toThrow(/llm\.response/);
	});

	it("rejects when blocked event leaks onto SSE", () => {
		const sseTypes = ["llm.response", "fs.read"];
		const jsonlTypes = new Set(["fs.read", "llm.response"]);
		expect(() => assertSseFilter(sseTypes, jsonlTypes, ["llm.response"], ["fs.read"])).toThrow(/fs\.read.*SSE/);
	});

	it("rejects when blocked event absent from JSONL — no proof tool was called", () => {
		const sseTypes = ["llm.response"];
		const jsonlTypes = new Set(["llm.response"]);
		expect(() => assertSseFilter(sseTypes, jsonlTypes, ["llm.response"], ["fs.read"])).toThrow(/JSONL/);
	});
});

// ---------------------------------------------------------------------------
// E2E-186: tool sequence
// ---------------------------------------------------------------------------

describe("verifier: assertToolSequence", { tags: ["unit"] }, () => {
	it("accepts lector.read before lector.edit", () => {
		const records = [
			rec("llm.response", "sense"),
			rec("lector.read"),
			rec("lector.read", "sense"),
			rec("lector.edit"),
			rec("lector.edit", "sense"),
			rec("llm.response"),
		];
		expect(() => assertToolSequence(records, ["lector.read", "lector.edit"])).not.toThrow();
	});

	it("accepts non-contiguous sequence — other tools in between are fine", () => {
		const records = [rec("lector.read"), rec("fs.grep"), rec("lector.read"), rec("lector.edit")];
		expect(() => assertToolSequence(records, ["lector.read", "lector.edit"])).not.toThrow();
	});

	it("rejects when lector.edit precedes lector.read", () => {
		const records = [rec("lector.edit"), rec("lector.read")];
		expect(() => assertToolSequence(records, ["lector.read", "lector.edit"])).toThrow(/sequence/);
	});

	it("rejects when required tool absent entirely", () => {
		const records = [rec("lector.edit"), rec("llm.response")];
		expect(() => assertToolSequence(records, ["lector.read", "lector.edit"])).toThrow();
	});

	it("accepts single-element sequence", () => {
		const records = [rec("fs.read"), rec("llm.response")];
		expect(() => assertToolSequence(records, ["fs.read"])).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// E2E-189: multi-turn history
// ---------------------------------------------------------------------------

describe("verifier: assertMultiTurnHistory", { tags: ["unit"] }, () => {
	it("accepts when both turns contain the secret", () => {
		expect(() =>
			assertMultiTurnHistory("The token is ABC-123", "You told me ABC-123 earlier.", "ABC-123"),
		).not.toThrow();
	});

	it("rejects when turn 1 does not contain the secret", () => {
		expect(() => assertMultiTurnHistory("I could not find the file.", "I don't recall.", "ABC-123")).toThrow(
			/turn 1/,
		);
	});

	it("rejects when turn 2 forgets the secret", () => {
		expect(() =>
			assertMultiTurnHistory("The token is ABC-123.", "I don't remember what I told you.", "ABC-123"),
		).toThrow(/turn 2/);
	});
});

// ---------------------------------------------------------------------------
// E2E-188: web fetch
// ---------------------------------------------------------------------------

describe("verifier: assertWebFetch", { tags: ["unit"] }, () => {
	it("accepts reply matching expected pattern", () => {
		expect(() => assertWebFetch("The page title is Example Domain.", /example\s*domain/i)).not.toThrow();
	});

	it("rejects reply not matching pattern", () => {
		expect(() => assertWebFetch("I could not fetch the page.", /example\s*domain/i)).toThrow(/pattern/);
	});

	it("accepts 404 status pattern", () => {
		expect(() => assertWebFetch("I received a 404 Not Found response.", /404/)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// E2E-subagent: outer agent delegates via agent.run
// ---------------------------------------------------------------------------

describe("verifier: assertSubagentWorkflow", { tags: ["unit"] }, () => {
	it("accepts agent.run in motor events and secret in reply", () => {
		const records = [rec("llm.response", "sense"), rec("agent.run"), rec("agent.run", "sense"), rec("llm.response")];
		expect(() => assertSubagentWorkflow(records, "The secret is XYZ-789", "XYZ-789")).not.toThrow();
	});

	it("rejects when agent.run is absent from motor events", () => {
		const records = [rec("fs.read"), rec("fs.read", "sense"), rec("llm.response")];
		expect(() => assertSubagentWorkflow(records, "The secret is XYZ-789", "XYZ-789")).toThrow(/agent\.run/);
	});

	it("rejects when reply does not contain the secret", () => {
		const records = [rec("agent.run"), rec("agent.run", "sense"), rec("llm.response")];
		expect(() => assertSubagentWorkflow(records, "I delegated the task.", "XYZ-789")).toThrow(/secret/);
	});

	it("rejects when motor events are empty", () => {
		expect(() => assertSubagentWorkflow([], "XYZ-789", "XYZ-789")).toThrow(/agent\.run/);
	});
});
