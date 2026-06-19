/**
 * @dpopsuev/alef-testkit/organ — slim subpath for organ unit tests.
 *
 * Exports only the primitives needed to test a single organ in isolation.
 * Does not pull in organ-dialog, organ-llm, alef-ai, or agent-blueprint.
 *
 * External organ developers use this subpath:
 *   import { NerveFixture, organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
 *
 * Internal organ developers use the same import — same experience regardless
 * of whether the organ lives in this monorepo or a separate repository.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export { BusEventRecorder } from "./bus-event-recorder.js";
export { MockReasoner } from "./mock-reasoner.js";
export { NerveFixture } from "./nerve-fixture.js";
export {
	assertOrganContract,
	type CapturedLog,
	type OrganComplianceOptions,
	type OrganContractOptions,
	type OrganContractReport,
	type OrganContractViolation,
	organComplianceSuite,
	runOrganContract,
	runSchemaContract,
	runStreamingContract,
	type SchemaContractResult,
	type StreamingToolConfig,
} from "./organ-contract.js";
export { OrganHarness } from "./organ-harness.js";
export { defineStubOrgan, type StubHandler } from "./stub-organ.js";

/**
 * Read and parse ~/.alef/debug.log as pino JSON lines.
 * Returns empty array if the file doesn't exist or a line fails to parse.
 * Use in tests that call debugLog to assert log output:
 *   const logs = readDebugLog();
 *   expect(logs.some(l => l.msg === "delegate:strategy:start")).toBe(true);
 */
export function readDebugLog(): Record<string, unknown>[] {
	const path = join(homedir(), ".alef", "debug.log");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});
}
