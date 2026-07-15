/**
 * OTel setup for the Alef runner — re-exports shared agent bootstrap.
 */
export {
	activateInheritedTraceContext,
	injectTraceContextIntoEnv,
	resetOTelForTests,
	runWithInheritedTrace,
	setupOTel,
	shouldEnableOTelForAgent,
	shutdownOTel,
	snapshotSpansForTests,
	upgradeToSqliteExporter,
} from "@dpopsuev/alef-agent/otel-setup";
