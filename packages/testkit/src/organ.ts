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

// Inline re-exports from index to avoid circular dependency
// BusEventRecorder and MockReasoner only import from @dpopsuev/alef-kernel and @dpopsuev/alef-corpus
export { BusEventRecorder, MockReasoner } from "./index.js";
export { NerveFixture } from "./nerve-fixture.js";
export {
	assertOrganContract,
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
