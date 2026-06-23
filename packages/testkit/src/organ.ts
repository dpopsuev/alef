/**
 * @dpopsuev/alef-testkit/adapter — slim subpath for adapter unit tests.
 *
 * Exports only the primitives needed to test a single adapter in isolation.
 * Does not pull in agent-controller, adapter-llm, alef-ai, or agent-blueprint.
 *
 * External adapter developers use this subpath:
 *   import { BusFixture, adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
 *
 * Internal adapter developers use the same import — same experience regardless
 * of whether the adapter lives in this monorepo or a separate repository.
 */

export {
	type AdapterComplianceOptions,
	type AdapterContractOptions,
	type AdapterContractReport,
	type AdapterContractViolation,
	adapterComplianceSuite,
	assertAdapterContract,
	type CapturedLog,
	runAdapterContract,
	runSchemaContract,
	runStreamingContract,
	type SchemaContractResult,
	type StreamingToolConfig,
} from "./adapter-contract.js";
export { AdapterHarness } from "./adapter-harness.js";
export { BusEventRecorder } from "./bus-event-recorder.js";
export { BusFixture } from "./bus-fixture.js";
export { MockReasoner } from "./mock-reasoner.js";
export { defineStubAdapter, type StubHandler } from "./stub-adapter.js";
