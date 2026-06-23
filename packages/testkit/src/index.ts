// defineFeature is in a separate subpath export: @dpopsuev/alef-testkit/bdd
// It is not in the main index because @amiceli/vitest-cucumber is a devDependency
// and would break production installs that import from this package.

export {
	type AdapterComplianceOptions,
	type AdapterContractOptions,
	type AdapterContractReport,
	type AdapterContractViolation,
	adapterComplianceSuite,
	assertAdapterContract,
	// Deprecated aliases
	assertOrganContract,
	type OrganComplianceOptions,
	type OrganContractOptions,
	type OrganContractReport,
	type OrganContractViolation,
	organComplianceSuite,
	runAdapterContract,
	runOrganContract,
	runSchemaContract,
	runStreamingContract,
	type SchemaContractResult,
	type StreamingToolConfig,
} from "./adapter-contract.js";
export { AdapterHarness, OrganHarness } from "./adapter-harness.js";
export { BlueprintGauntlet, type GauntletOptions, type GauntletSendOptions } from "./blueprint-gauntlet.js";
export { type BlueprintFromFileOptions, BlueprintHarness, type BlueprintHarnessOptions } from "./blueprint-harness.js";
export { BusEventRecorder } from "./bus-event-recorder.js";
export { BusFixture, BusFixture as NerveFixture } from "./bus-fixture.js";
export {
	createE2eSession,
	type E2eResult,
	type E2eSession,
	type E2eSessionOptions,
	HAVE_REAL_LLM,
} from "./e2e-session.js";
export { InMemorySessionStore } from "./in-memory-session-store.js";
export { MockReasoner } from "./mock-reasoner.js";
export { type ScriptStep, step, type ToolCallSpec } from "./script.js";
export { ScriptedReasoner, type ToolCallEnd, type ToolCallStart } from "./scripted-reasoner.js";
export { defineStubAdapter, defineStubAdapter as defineStubOrgan, type StubHandler } from "./stub-adapter.js";
export { TurnDriver } from "./turn-driver.js";
