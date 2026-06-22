/**
 * @dpopsuev/alef-testkit/organ — slim subpath for organ unit tests.
 *
 * Exports only the primitives needed to test a single organ in isolation.
 * Does not pull in agent-controller, organ-llm, alef-ai, or agent-blueprint.
 *
 * External organ developers use this subpath:
 *   import { NerveFixture, organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
 *
 * Internal organ developers use the same import — same experience regardless
 * of whether the organ lives in this monorepo or a separate repository.
 */

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
