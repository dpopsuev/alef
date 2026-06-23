/**
 * @dpopsuev/alef-testkit/adapter — slim subpath for adapter unit tests.
 *
 * Exports only the primitives needed to test a single adapter in isolation.
 * Does not pull in agent-controller, adapter-llm, alef-ai, or agent-blueprint.
 *
 * External adapter developers use this subpath:
 *   import { BusFixture, organComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
 *
 * Internal adapter developers use the same import — same experience regardless
 * of whether the adapter lives in this monorepo or a separate repository.
 */

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
} from "./adapter-contract.js";
export { AdapterHarness, OrganHarness } from "./adapter-harness.js";
export { BusEventRecorder } from "./bus-event-recorder.js";
export { BusFixture, BusFixture as NerveFixture } from "./bus-fixture.js";
export { MockReasoner } from "./mock-reasoner.js";
export { defineStubAdapter, defineStubAdapter as defineStubOrgan, type StubHandler } from "./stub-adapter.js";
